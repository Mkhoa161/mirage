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

import re

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.provision import pure_provision
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# GNU expr's operand grammar, which is narrower than either language's
# own integer parser: no sign but a leading `-`, no surrounding space,
# no digit separator, no `0x`/`1e3` form. Leading zeros are decimal, so
# `05` is 5. Spelled `[0-9]` rather than `\d` because python's `\d`
# also matches non-ASCII digits, where the TypeScript twin
# (`parseIntStrict`, expr.ts) is ASCII-only.
INT_OPERAND_RE = re.compile(r"^-?[0-9]+$")

ARITH_OPS = ("+", "-", "*", "/", "%")
CMP_OPS = ("=", "!=", "<", ">", "<=", ">=")

NON_INTEGER = "expr: non-integer argument"
DIVISION_BY_ZERO = "expr: division by zero"


class ExprError(Exception):
    """An operand or operation GNU expr refuses, worded as GNU words it."""


def parse_int_operand(text: str) -> int:
    """One expr operand read as GNU reads it.

    Args:
        text (str): the operand exactly as it arrived on the line.

    Returns:
        int: the parsed value. GNU expr is arbitrary precision, so no
            bound is applied here. The TypeScript twin reads the same
            grammar into a float64 and so cannot answer exactly past
            2**53; that gap predates this parser and no case pins a
            value that large.

    Raises:
        ExprError: the operand is not an integer in GNU's grammar.
    """
    if INT_OPERAND_RE.match(text) is None:
        raise ExprError(NON_INTEGER)
    return int(text)


def int_operand_or_none(text: str) -> int | None:
    """The same read, for a comparison that falls back to strings.

    Args:
        text (str): the operand exactly as it arrived on the line.

    Returns:
        int | None: the parsed value, or None when the operand is not an
            integer in GNU's grammar.
    """
    if INT_OPERAND_RE.match(text) is None:
        return None
    return int(text)


def trunc_div(a: int, b: int) -> int:
    """Integer division truncated toward zero, as C and GNU expr do it.

    Python's `//` floors, so `-10 // 3` is -4 where GNU expr says -3.
    Implemented here rather than borrowed from `shell/arith.py`: those
    helpers are private to the shell's `$(( ))` evaluator, importing
    them would cross a package boundary, and they raise the shell's
    `division by 0` wording rather than expr's.

    Args:
        a (int): the dividend.
        b (int): the divisor.

    Returns:
        int: the quotient, rounded toward zero.

    Raises:
        ExprError: the divisor is zero.
    """
    if b == 0:
        raise ExprError(DIVISION_BY_ZERO)
    quotient = abs(a) // abs(b)
    return -quotient if (a < 0) != (b < 0) else quotient


def trunc_mod(a: int, b: int) -> int:
    """The remainder that takes the dividend's sign, as GNU expr does.

    `-10 % 3` is -1 and `10 % -3` is 1, where Python's `%` answers 2 and
    -2. GNU reports a zero divisor here with the same `division by zero`
    message it uses for `/`, not a modulo variant.

    Args:
        a (int): the dividend.
        b (int): the divisor.

    Returns:
        int: the remainder, signed like `a`.

    Raises:
        ExprError: the divisor is zero.
    """
    if b == 0:
        raise ExprError(DIVISION_BY_ZERO)
    remainder = abs(a) % abs(b)
    return -remainder if a < 0 else remainder


def _expr_eval(args: list[str]) -> tuple[str, int]:
    if len(args) == 3 and args[1] == ":":
        pattern = args[2]
        m = re.match(pattern, args[0])
        if m:
            result = m.group(1) if m.lastindex else str(m.end())
        else:
            result = ""
        exit_code = 1 if result == "" or result == "0" else 0
        return result, exit_code
    if len(args) == 3 and args[1] in ARITH_OPS:
        a = parse_int_operand(args[0])
        b = parse_int_operand(args[2])
        op = args[1]
        if op == "+":
            val = a + b
        elif op == "-":
            val = a - b
        elif op == "*":
            val = a * b
        elif op == "/":
            val = trunc_div(a, b)
        else:
            val = trunc_mod(a, b)
        result = str(val)
        # GNU expr exits 1 when the value is `0` or empty even on full
        # success, so exit 1 means "the answer was zero" and exit 2 is
        # the only error status.
        exit_code = 1 if result == "0" else 0
        return result, exit_code
    if len(args) == 3 and args[1] in CMP_OPS:
        left, op, right = args[0], args[1], args[2]
        maybe_left = int_operand_or_none(left)
        maybe_right = int_operand_or_none(right)
        numeric = maybe_left is not None and maybe_right is not None
        if numeric:
            l_val = maybe_left if maybe_left is not None else 0
            r_val = maybe_right if maybe_right is not None else 0
            cmp_map = {
                "=": l_val == r_val,
                "!=": l_val != r_val,
                "<": l_val < r_val,
                ">": l_val > r_val,
                "<=": l_val <= r_val,
                ">=": l_val >= r_val,
            }
        else:
            cmp_map = {
                "=": left == right,
                "!=": left != right,
                "<": left < right,
                ">": left > right,
                "<=": left <= right,
                ">=": left >= right,
            }
        val = 1 if cmp_map[op] else 0
        result = str(val)
        exit_code = 1 if result == "0" else 0
        return result, exit_code
    return "", 2


@command("expr", resource=None, spec=SPECS["expr"], provision=pure_provision)
async def expr(accessor: Accessor, paths: list[PathSpec] | None,
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        return b"\n", IOResult(exit_code=2)
    try:
        result, exit_code = _expr_eval(texts)
    except ExprError as exc:
        # GNU writes the refusal to stderr, nothing to stdout, and exits
        # 2; exit 1 is reserved for a zero-valued success.
        return None, IOResult(exit_code=2, stderr=f"{exc}\n".encode())
    return (result + "\n").encode(), IOResult(exit_code=exit_code)
