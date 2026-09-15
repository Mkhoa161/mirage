# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import math
from collections.abc import Callable
from dataclasses import dataclass

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.provision import pure_provision
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# Grammar, ported from `bc.ts` so the two hosts parse one language
# (precedence low to high):
#   statement := 'scale' '=' expr | expr
#   expr      := term   { (+|-) term }
#   term      := unary  { (*|/|%) unary }
#   unary     := (+|-) unary | power
#   power     := atom ^ unary | atom
#   atom      := number | '(' expr ')' | 'scale' | func '(' expr ')'
#               | func atom
#   func      := sqrt | s | c | a | l | e   (all but sqrt need -l)

# `-l` loads the math library, which sets scale to 20. Without it bc's
# scale is 0, which is why plain `7/2` is 3 and `bc -l` answers 3.50...
MATH_LIBRARY_SCALE = 20

# The largest scale either host can render. JavaScript's
# `Number.prototype.toFixed` refuses a fractionDigits above 100, so a
# larger scale could not be printed identically by the TypeScript twin;
# it also bounds what a typed `scale=` can make this allocate. GNU bc
# accepts more, which is a documented divergence.
MAX_SCALE = 100

# GNU renders a non-fatal runtime error with the bytecode address it
# happened at. The address depends on everything parsed before it, so it
# is not derivable here; 3 is what GNU emits for a bare `1/0` as the
# first statement, which is the measured case, and both hosts use the
# same constant so parity holds for the rest.
RUNTIME_ERROR_ADDR = 3

DIVIDE_BY_ZERO = "Divide by zero"
MODULO_BY_ZERO = "Modulo by zero"


class BcError(Exception):
    """Input bc cannot parse at all; the run stops and exits 1."""


class BcRuntimeError(Exception):
    """A non-fatal runtime error: reported, then evaluation continues."""


@dataclass(frozen=True, slots=True)
class BcNumber:
    """A bc value and the number of fractional digits it prints with.

    bc tracks a scale per value, not just globally, which is the whole
    reason `0.1+0.2` prints `.3` at the default scale of 0: addition
    keeps the wider of its operands' scales, while division adopts the
    global one.

    Args:
        value (float): the numeric value.
        scale (int): fractional digits this value renders with.
    """

    value: float
    scale: int


@dataclass(slots=True)
class BcState:
    """What survives between statements on one bc run.

    Args:
        scale (int): the global `scale` register.
        math_mode (bool): whether `-l` loaded the math library.
    """

    scale: int
    math_mode: bool


def clamp_scale(scale: int) -> int:
    """Hold a scale inside the range both hosts can render.

    Args:
        scale (int): the requested scale.

    Returns:
        int: the scale, clamped to 0..MAX_SCALE.
    """
    return max(0, min(scale, MAX_SCALE))


def bc_log(x: float) -> float:
    """Natural log with JavaScript's answers at the domain edges.

    `math.log` raises where `Math.log` returns -Infinity or NaN, and the
    two hosts have to agree, so the edges are answered explicitly.

    Args:
        x (float): the argument.

    Returns:
        float: the natural log, -inf at zero, nan below it.
    """
    if x == 0:
        return -math.inf
    if x < 0:
        return math.nan
    return math.log(x)


def bc_exp(x: float) -> float:
    """`e^x`, saturating to infinity as JavaScript's `Math.exp` does.

    Args:
        x (float): the exponent.

    Returns:
        float: the exponential, or inf when it overflows float64.
    """
    try:
        return math.exp(x)
    except OverflowError:
        # Not swallowed: JavaScript's Math.exp answers Infinity here and
        # the hosts must render the same thing.
        return math.inf


def bc_sqrt(x: float) -> float:
    """Square root, answering NaN below zero as `Math.sqrt` does.

    Args:
        x (float): the argument.

    Returns:
        float: the square root, nan for a negative argument.
    """
    if x < 0:
        return math.nan
    return math.sqrt(x)


def float_pow(base: float, exponent: int) -> float:
    """`base ** exponent`, saturating instead of raising.

    Args:
        base (float): the base.
        exponent (int): the exponent, already truncated to an integer.

    Returns:
        float: the power, or a signed infinity when it overflows float64.

    Raises:
        BcRuntimeError: zero raised to a negative power, which bc reports
            as a divide by zero.
    """
    if base == 0 and exponent < 0:
        raise BcRuntimeError(DIVIDE_BY_ZERO)
    try:
        return float(base**exponent)
    except OverflowError:
        # Not swallowed: JavaScript's `**` answers a signed Infinity
        # here, and the hosts must render the same thing.
        if base < 0 and exponent % 2 != 0:
            return -math.inf
        return math.inf


# The math library, whose members are reachable only under -l. `sqrt` is
# not one of them: GNU bc has it built in, so it answers without the
# flag, and it is dispatched separately below.
MATH_FUNCS: dict[str, Callable[[float], float]] = {
    "s": math.sin,
    "c": math.cos,
    "a": math.atan,
    "l": bc_log,
    "e": bc_exp,
}

SQRT_NAME = "sqrt"
SCALE_NAME = "scale"

DIGITS = "0123456789."
# ASCII only, matching `/[a-z]/` in the TypeScript twin: python's
# `str.isalpha` would also admit an uppercase or non-ASCII letter, and
# the two hosts have to refuse the same lines.
NAME_CHARS = "abcdefghijklmnopqrstuvwxyz"


def truncate_to_scale(value: float, scale: int) -> float:
    """Drop the digits past `scale`, rounding toward zero as bc does.

    Args:
        value (float): the value to truncate.
        scale (int): fractional digits to keep.

    Returns:
        float: the truncated value, or the value unchanged when scaling
            it would leave float64's range.
    """
    # Built as an exact integer power and converted once, which is the
    # correctly-rounded double for every scale here. `10.0**scale` is not:
    # libm's `pow` puts `10.0**23` one ulp above `1e23`, while the
    # TypeScript side reads the decimal literal `1e23` and gets the
    # correctly-rounded value, so the two hosts would disagree in the
    # last digits at scale 23 and nowhere else. `scale` is always
    # `clamp_scale`d to 0..100, so the integer power cannot overflow.
    factor = float(10**scale)
    scaled = value * factor
    if not math.isfinite(scaled):
        return value
    return math.trunc(scaled) / factor


def nonfinite_text(value: float) -> str:
    """Spell an infinity or NaN the way JavaScript's `String` spells it.

    GNU bc is exact and has no such value, so there is nothing to match
    against; matching the other host is what is left.

    Args:
        value (float): a value that is not finite.

    Returns:
        str: `NaN`, `Infinity` or `-Infinity`.
    """
    if math.isnan(value):
        return "NaN"
    return "Infinity" if value > 0 else "-Infinity"


def render_number(num: BcNumber) -> str:
    """Render one printed bc value.

    Two GNU spellings that are easy to miss: an exact zero prints as a
    bare `0` whatever the scale, and a value below one carries no
    leading zero, so `0.1+0.2` is `.3` rather than `0.3`.

    Args:
        num (BcNumber): the value and the scale it prints with.

    Returns:
        str: the line bc would print, without its newline.
    """
    if not math.isfinite(num.value):
        return nonfinite_text(num.value)
    if num.value == 0:
        return "0"
    text = f"{num.value:.{clamp_scale(num.scale)}f}"
    if text.startswith("0."):
        return text[1:]
    if text.startswith("-0."):
        return "-" + text[2:]
    return text


def runtime_error_line(reason: str) -> str:
    """GNU's stderr line for a non-fatal runtime error.

    Args:
        reason (str): the reason text, e.g. `Divide by zero`.

    Returns:
        str: the full line, without its newline.
    """
    return f"Runtime error (func=(main), adr={RUNTIME_ERROR_ADDR}): {reason}"


def add_scale(a: BcNumber, b: BcNumber) -> int:
    """The scale bc gives a sum or difference.

    Args:
        a (BcNumber): the left operand.
        b (BcNumber): the right operand.

    Returns:
        int: the wider of the two operand scales.
    """
    return clamp_scale(max(a.scale, b.scale))


def mul_scale(a: BcNumber, b: BcNumber, scale: int) -> int:
    """The scale bc gives a product.

    Args:
        a (BcNumber): the left operand.
        b (BcNumber): the right operand.
        scale (int): the global scale register.

    Returns:
        int: `min(scale(a)+scale(b), max(scale, scale(a), scale(b)))`.
    """
    return clamp_scale(min(a.scale + b.scale, max(scale, a.scale, b.scale)))


def pow_scale(a: BcNumber, exponent: int, scale: int) -> int:
    """The scale bc gives a power.

    Args:
        a (BcNumber): the base.
        exponent (int): the truncated integer exponent.
        scale (int): the global scale register.

    Returns:
        int: the global scale for a negative exponent, otherwise
            `min(scale(a)*exponent, max(scale, scale(a)))`.
    """
    if exponent < 0:
        return clamp_scale(scale)
    return clamp_scale(min(a.scale * exponent, max(scale, a.scale)))


def divide(a: BcNumber, b: BcNumber, scale: int) -> BcNumber:
    """bc's `/`: truncate the quotient to the global scale.

    Args:
        a (BcNumber): the dividend.
        b (BcNumber): the divisor.
        scale (int): the global scale register.

    Returns:
        BcNumber: the quotient at the global scale.

    Raises:
        BcRuntimeError: the divisor is zero.
    """
    if b.value == 0:
        raise BcRuntimeError(DIVIDE_BY_ZERO)
    return BcNumber(truncate_to_scale(a.value / b.value, scale),
                    clamp_scale(scale))


def modulo(a: BcNumber, b: BcNumber, scale: int) -> BcNumber:
    """bc's `%`: `a - (a/b)*b`, with the quotient truncated first.

    The remainder therefore takes the dividend's sign, so `-7%2` is -1.

    Args:
        a (BcNumber): the dividend.
        b (BcNumber): the divisor.
        scale (int): the global scale register.

    Returns:
        BcNumber: the remainder, at `max(scale+scale(b), scale(a))`.

    Raises:
        BcRuntimeError: the divisor is zero.
    """
    if b.value == 0:
        raise BcRuntimeError(MODULO_BY_ZERO)
    quotient = truncate_to_scale(a.value / b.value, scale)
    return BcNumber(a.value - quotient * b.value,
                    clamp_scale(max(scale + b.scale, a.scale)))


def call_function(name: str, arg: BcNumber, scale: int) -> BcNumber:
    """Apply one built-in or math-library function.

    Args:
        name (str): the function name, already known to exist.
        arg (BcNumber): the argument.
        scale (int): the global scale register.

    Returns:
        BcNumber: the result at `max(scale, scale(arg))`.
    """
    fn = bc_sqrt if name == SQRT_NAME else MATH_FUNCS[name]
    return BcNumber(fn(arg.value), clamp_scale(max(scale, arg.scale)))


class Parser:
    """A recursive-descent parser for one bc statement.

    It replaces the `eval()` this command used to run on agent-typed
    text, and mirrors `Parser` in `bc.ts` method for method so the two
    hosts accept and refuse the same lines.

    Args:
        src (str): the statement text.
        state (BcState): the run's scale register and math-library flag.
    """

    __slots__ = ("_src", "_pos", "_state")

    def __init__(self, src: str, state: BcState) -> None:
        self._src = src
        self._pos = 0
        self._state = state

    def _skip_blanks(self) -> None:
        while self._pos < len(self._src) and self._src[self._pos] in " \t":
            self._pos += 1

    def _peek(self) -> str:
        self._skip_blanks()
        if self._pos < len(self._src):
            return self._src[self._pos]
        return ""

    def _consume(self) -> str:
        char = self._peek()
        self._pos += 1
        return char

    def _match(self, text: str) -> bool:
        self._skip_blanks()
        if self._src.startswith(text, self._pos):
            self._pos += len(text)
            return True
        return False

    def _read_number(self) -> BcNumber:
        start = self._pos
        while self._pos < len(self._src) and self._src[self._pos] in DIGITS:
            self._pos += 1
        raw = self._src[start:self._pos]
        try:
            value = float(raw)
        except ValueError as exc:
            raise BcError(f"bc: invalid number: {raw}") from exc
        _, _, fraction = raw.partition(".")
        return BcNumber(value, clamp_scale(len(fraction)))

    def _read_identifier(self) -> str:
        start = self._pos
        while (self._pos < len(self._src)
               and self._src[self._pos] in NAME_CHARS):
            self._pos += 1
        return self._src[start:self._pos]

    def parse_statement(self) -> str | None:
        """Parse one statement, printing nothing for an assignment.

        Returns:
            str | None: the rendered value, or None when the statement
                was an assignment, which bc prints nothing for.
        """
        if self._try_scale_assignment():
            value = self.parse_expr()
            self._state.scale = clamp_scale(math.trunc(value.value))
            return None
        return render_number(self.parse_expr())

    def _try_scale_assignment(self) -> bool:
        mark = self._pos
        self._skip_blanks()
        if self._read_identifier() != SCALE_NAME:
            self._pos = mark
            return False
        self._skip_blanks()
        rest = self._src[self._pos:]
        if not rest.startswith("=") or rest.startswith("=="):
            self._pos = mark
            return False
        self._pos += 1
        return True

    def parse_expr(self) -> BcNumber:
        """Parse an additive expression.

        Returns:
            BcNumber: the value and its scale.
        """
        left = self._parse_term()
        while True:
            char = self._peek()
            if char == "+":
                self._consume()
                right = self._parse_term()
                left = BcNumber(left.value + right.value,
                                add_scale(left, right))
            elif char == "-":
                self._consume()
                right = self._parse_term()
                left = BcNumber(left.value - right.value,
                                add_scale(left, right))
            else:
                return left

    def _parse_term(self) -> BcNumber:
        left = self._parse_unary()
        while True:
            char = self._peek()
            if char == "*":
                self._consume()
                right = self._parse_unary()
                left = BcNumber(left.value * right.value,
                                mul_scale(left, right, self._state.scale))
            elif char == "/":
                self._consume()
                left = divide(left, self._parse_unary(), self._state.scale)
            elif char == "%":
                self._consume()
                left = modulo(left, self._parse_unary(), self._state.scale)
            else:
                return left

    def _parse_unary(self) -> BcNumber:
        char = self._peek()
        if char == "-":
            self._consume()
            operand = self._parse_unary()
            return BcNumber(-operand.value, operand.scale)
        if char == "+":
            self._consume()
            return self._parse_unary()
        return self._parse_power()

    def _parse_power(self) -> BcNumber:
        base = self._parse_atom()
        if self._peek() != "^":
            return base
        self._consume()
        raw_exponent = self._parse_unary()
        exponent = math.trunc(raw_exponent.value)
        return BcNumber(float_pow(base.value, exponent),
                        pow_scale(base, exponent, self._state.scale))

    def _parse_atom(self) -> BcNumber:
        char = self._peek()
        if char == "":
            raise BcError("bc: unexpected end of expression")
        if char == "(":
            self._consume()
            value = self.parse_expr()
            if not self._match(")"):
                raise BcError("bc: missing )")
            return value
        if char in DIGITS:
            return self._read_number()
        if char in NAME_CHARS:
            return self._parse_name()
        raise BcError(f'bc: unexpected character "{char}"')

    def _parse_name(self) -> BcNumber:
        name = self._read_identifier()
        if name == SCALE_NAME:
            return BcNumber(float(self._state.scale), 0)
        known = name == SQRT_NAME or (self._state.math_mode
                                      and name in MATH_FUNCS)
        if not known:
            if self._state.math_mode:
                raise BcError(f"bc: unknown function {name}")
            raise BcError("bc: identifiers not allowed without -l flag")
        if self._match("("):
            arg = self.parse_expr()
            if not self._match(")"):
                raise BcError("bc: missing )")
            return call_function(name, arg, self._state.scale)
        return call_function(name, self._parse_atom(), self._state.scale)

    def done(self) -> bool:
        """Whether the whole statement was consumed.

        Returns:
            bool: True when only blanks remain.
        """
        self._skip_blanks()
        return self._pos >= len(self._src)


def eval_statement(text: str, state: BcState) -> str | None:
    """Evaluate one bc statement against the run's state.

    Args:
        text (str): the statement, already split off and stripped.
        state (BcState): the run's scale register and math-library flag.

    Returns:
        str | None: the line to print, or None for an assignment.

    Raises:
        BcError: the statement cannot be parsed.
        BcRuntimeError: a non-fatal runtime error such as a zero divisor.
    """
    parser = Parser(text, state)
    rendered = parser.parse_statement()
    if not parser.done():
        raise BcError("bc: trailing input")
    return rendered


def split_statements(text: str) -> list[str]:
    """Split bc input into statements on newlines and semicolons.

    Args:
        text (str): the decoded stdin.

    Returns:
        list[str]: the non-empty statements, in order.
    """
    return [
        statement.strip() for line in text.strip().splitlines()
        for statement in line.split(";") if statement.strip()
    ]


@command("bc", resource=None, spec=SPECS["bc"], provision=pure_provision)
async def bc(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["bc"])
    use_math = fl.as_bool("args_l")
    raw = await read_stdin_async(opts.stdin)
    if raw is None:
        raw = b""
    state = BcState(scale=MATH_LIBRARY_SCALE if use_math else 0,
                    math_mode=use_math)
    results: list[str] = []
    errors: list[str] = []
    for statement in split_statements(raw.decode(errors="replace")):
        try:
            rendered = eval_statement(statement, state)
        except BcRuntimeError as exc:
            # GNU treats this as non-fatal: it names the error on stderr,
            # prints nothing for the statement, keeps evaluating the rest
            # and still exits 0.
            errors.append(runtime_error_line(str(exc)))
            continue
        except BcError as exc:
            errors.append(str(exc))
            return None, IOResult(exit_code=1,
                                  stderr=("\n".join(errors) + "\n").encode())
        if rendered is not None:
            results.append(rendered)
    stdout = ("\n".join(results) + "\n").encode() if results else b""
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return stdout, IOResult(stderr=stderr)
