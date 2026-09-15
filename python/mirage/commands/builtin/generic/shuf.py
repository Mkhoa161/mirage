import random
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# GNU accepts a leading `+` and reads `+2` as 2, and `0` is a valid head
# count. A `-` is not a sign here but an invalid character, so `-1` is
# refused and quoted whole with no out-of-range clause: shuf rejects the
# sign while scanning rather than range-checking a parsed negative.
_LINE_COUNT = re.compile(r"^\+?[0-9]+$")

# `-i` takes two unsigned bounds with the low one no greater than the
# high one. Every other shape is one message, so a negative low bound
# (`-2-1`) and a decreasing range (`3-1`) are refused here rather than
# read as a range; shuf has no decreasing-range diagnostic of its own.
_INPUT_RANGE = re.compile(r"^([0-9]+)-([0-9]+)$")


@dataclass(frozen=True, slots=True)
class ShufFlags:
    count: int | None = None
    echo: bool = False
    zero_terminated: bool = False
    with_replacement: bool = False
    input_range: str | None = None
    output: PathSpec | None = None


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
    if count_raw is not None and _LINE_COUNT.match(count_raw) is None:
        raise ValueError(f"shuf: invalid line count: '{count_raw}'")
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
        bounds = _INPUT_RANGE.match(input_range)
        if bounds is None or int(bounds.group(1)) > int(bounds.group(2)):
            raise ValueError(f"shuf: invalid input range: '{input_range}'")
        items = [
            str(value) for value in range(int(bounds.group(1)),
                                          int(bounds.group(2)) + 1)
        ]
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
            raise ValueError("shuf: backend provides no write op")
        await write_bytes(output, rendered)
        return None, IOResult(writes={output.mount_path: rendered})
    return rendered, IOResult()


__all__ = ["ShufFlags", "parse_flags", "shuf"]
