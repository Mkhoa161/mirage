import random
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# GNU accepts a leading `+` and reads `+2` as 2, and `0` is a valid head
# count. A `-` is not a sign here but an invalid character, so `-1` is
# refused and quoted whole with no out-of-range clause: shuf rejects the
# sign while scanning rather than range-checking a parsed negative.
#
# Matched with `fullmatch`, never `match`: python's `$` also matches
# immediately BEFORE a trailing newline, so `^...$` with `match` reads
# `shuf -n $'2\n'` as the valid count 2. GNU's scanner stops at the
# first non-digit and refuses it, as does the TypeScript twin.
#
# The leading run of C whitespace is `strtoumax`'s own skip and is real
# GNU behavior: `shuf -n ' 2'`, `$'\t2'`, `$'\n2'` and `' +2'` are all
# accepted while `'2 '` is refused. The class is spelled out rather than
# written `\s` because it is C `isspace`, and python's `\s` also matches
# 0x1c-0x1f, which GNU refuses. Measured, ground truth NL3-C.
# A `-o` reached a backend wired without a write op, which is a wiring
# fault rather than anything the command line did wrong. The TypeScript
# twin throws a bare `Error` for it where it RETURNS an IOResult for
# every user-facing refusal, so the builder's local catch has to let
# this one through; naming it here is what keeps the two in step.
NO_WRITE_OP = "shuf: backend provides no write op"

_C_SPACE = r"[ \t\n\v\f\r]*"
_LINE_COUNT = re.compile(rf"{_C_SPACE}\+?[0-9]+")

# One `-i` bound. GNU splits the argument at the FIRST dash and hands
# each side to `strtoumax`, so each bound carries its own leading
# whitespace and optional `+`: `-i +1-3`, `-i 1-+3` and `-i '1- 3'` are
# all accepted (the blank belongs to the HIGH bound), while `-i '1 -3'`
# is refused because the blank is trailing garbage on the low one. A `-`
# is never a sign here, which is why `-i -1-3` (an empty low bound) and
# `-i 1--3` (a negative high bound) are both refused, and why there is
# no separate decreasing-range message. Measured, ground truth NL3-D.
_BOUND = re.compile(rf"{_C_SPACE}\+?[0-9]+")

# `-i` takes two unsigned bounds with the low one no greater than the
# high one. Every other shape is one message, so a negative low bound
# (`-2-1`) and a decreasing range (`3-1`) are refused with the same
# wording; shuf has no decreasing-range diagnostic of its own.


@dataclass(frozen=True, slots=True)
class ShufFlags:
    count: int | None = None
    echo: bool = False
    zero_terminated: bool = False
    with_replacement: bool = False
    input_range: str | None = None
    output: PathSpec | None = None


def parse_input_range(raw: str) -> tuple[int, int] | None:
    """GNU's ``-i LO-HI``, read the way GNU reads it.

    Split at the FIRST dash and scan each side on its own, which is what
    ``strchr(optarg, '-')`` plus two ``strtoumax`` calls amount to. Doing
    it as one regex over the whole argument gets three shapes wrong:
    ``-i +1-3`` and ``-i 1-+3`` carry a ``+`` on either bound
    independently, ``-i '1- 3'`` puts the blank on the HIGH bound's
    prefix and is accepted, and ``-i '1 -3'`` is refused because that
    same blank is trailing garbage on the LOW one.

    A ``-`` is never a sign here, so an empty low bound (``-i -1-3``,
    where the first dash is at index 0) and a negative high bound
    (``-i 1--3``) are both refused, as is a second dash anywhere
    (``-i 1-2-3``). Measured, ground truth NL3-D.

    Args:
        raw (str): the raw ``-i`` value.

    Returns:
        tuple[int, int] | None: the inclusive bounds, or None when GNU
            refuses the argument -- including when the range decreases,
            since shuf has only the one message for all of it.
    """
    dash = raw.find("-")
    if dash < 0:
        return None
    if _BOUND.fullmatch(raw[:dash]) is None:
        return None
    if _BOUND.fullmatch(raw[dash + 1:]) is None:
        return None
    low = int(raw[:dash])
    high = int(raw[dash + 1:])
    if low > high:
        return None
    return low, high


def parse_flags(flags: Mapping[str, FlagValue]) -> ShufFlags:
    """Read shuf's flags once, refusing a head count GNU refuses.

    GNU quotes the WHOLE ``-n`` argument, not just the unparsed
    remainder the way expand and cut do, and never appends an
    out-of-range clause to it. Pre-validated the way head/tail do it, so
    the ``int`` below cannot see a prefix.

    Args:
        flags (Mapping[str, FlagValue]): the dispatcher's flag bag.

    Raises:
        ValueError: the single stderr line to print, exit 1.
    """
    fl = FlagView(flags, spec=SPECS["shuf"])
    count_raw = fl.as_str("head_count")
    if count_raw is not None and _LINE_COUNT.fullmatch(count_raw) is None:
        raise ValueError(
            f"shuf: invalid line count: '{quote_text(count_raw)}'")
    outputs = fl.as_paths("output")
    return ShufFlags(
        count=int(count_raw) if count_raw is not None else None,
        echo=fl.as_bool("echo"),
        zero_terminated=fl.as_bool("zero_terminated"),
        with_replacement=fl.as_bool("repeat"),
        input_range=fl.as_str("input_range"),
        output=outputs[0] if outputs else None,
    )


def _render(result: list[str], sep: str) -> bytes:
    """Terminate every emitted line, and emit nothing for no lines.

    ``shuf -n 0`` is valid and prints zero bytes, so the separator is
    per line rather than appended to the join.

    Args:
        result (list[str]): the sampled lines, already in output order.
        sep (str): the line terminator, NUL under ``-z``.

    Returns:
        bytes: the rendered output, empty when nothing was sampled.
    """
    if not result:
        return b""
    return (sep.join(result) + sep).encode()


def _sample(items: list[str], count: int | None,
            with_replacement: bool) -> list[str]:
    if with_replacement:
        n = count if count is not None else len(items)
        return random.choices(items, k=n) if items else []
    out = list(items)
    random.shuffle(out)
    if count is not None:
        out = out[:count]
    return out


async def shuf(
    paths: list[PathSpec],
    texts: list[str],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    count: int | None = None,
    echo: bool = False,
    zero_terminated: bool = False,
    with_replacement: bool = False,
    input_range: str | None = None,
    output: PathSpec | None = None,
    write_bytes: Callable[[PathSpec, bytes], Awaitable[None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    sep = "\x00" if zero_terminated else "\n"

    if input_range is not None:
        bounds = parse_input_range(input_range)
        if bounds is None:
            raise ValueError(
                f"shuf: invalid input range: '{quote_text(input_range)}'")
        items = [str(value) for value in range(bounds[0], bounds[1] + 1)]
        result = _sample(items, count, with_replacement)
        rendered = _render(result, sep)
    elif echo:
        items = [p.mount_path for p in paths] if paths else list(texts)
        result = _sample(items, count, with_replacement)
        rendered = _render(result, sep)
    elif paths:
        all_lines: list[str] = []
        for p in paths:
            data = (await read_bytes(p)).decode(errors="replace")
            if zero_terminated:
                all_lines.extend(data.split("\x00"))
            else:
                all_lines.extend(split_lines(data))
        result = _sample(all_lines, count, with_replacement)
        rendered = _render(result, sep)
    else:
        raw = await read_stdin_async(stdin)
        if raw is None:
            raise ValueError("shuf: missing operand")
        text = raw.decode(errors="replace")
        lines = text.split("\x00") if zero_terminated else split_lines(text)
        result = _sample(lines, count, with_replacement)
        rendered = _render(result, sep)
    if output is not None:
        if write_bytes is None:
            raise ValueError(NO_WRITE_OP)
        await write_bytes(output, rendered)
        return None, IOResult(writes={output.mount_path: rendered})
    return rendered, IOResult()


__all__ = [
    "NO_WRITE_OP", "ShufFlags", "parse_flags", "parse_input_range", "shuf"
]
