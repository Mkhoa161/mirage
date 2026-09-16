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

import asyncio

import pytest

from mirage.commands.builtin.generic.shuf import (NO_WRITE_OP, parse_flags,
                                                  parse_input_range, shuf)
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace


def _ws():
    mem = RAMResource()
    ws = Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return ws, mem


def _run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.execute(cmd, stdin=stdin))
    return io.stdout, io


def _bytes(stdout):
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


async def _collect(ait):
    return [chunk async for chunk in ait]


def test_shuf_e():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "shuf -e a b c", cwd="/data")
    lines = _bytes(stdout).strip().decode().split("\n")
    assert len(lines) == 3
    assert sorted(lines) == sorted(["/a", "/b", "/c"])


def test_shuf_n():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "shuf -e -n 2 a b c d e", cwd="/data")
    lines = _bytes(stdout).strip().decode().split("\n")
    assert len(lines) == 2


def test_shuf_r():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "shuf -r -e -n 5 a b c", cwd="/data")
    lines = _bytes(stdout).strip().decode().split("\n")
    assert len(lines) == 5


async def _unused_read_bytes(_path):
    raise AssertionError("read_bytes should not be called for -i")


@pytest.mark.parametrize("raw", ["abc", "2x"])
def test_shuf_head_count_refusal_quotes_the_whole_argument(raw):
    """GNU quotes all of `-n 2x`, unlike expand and cut."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, f"shuf -e -n {raw} a b c", cwd="/data")
    assert io.exit_code == 1
    assert io.stderr == f"shuf: invalid line count: '{raw}'\n".encode()
    assert not stdout


@pytest.mark.parametrize("raw", [" 5 ", "1_0", "0x10", "1e3", ""])
def test_shuf_head_count_is_as_strict_as_gnu(raw):
    """`int()` reads ` 5 ` and `1_0` whole; GNU refuses both."""
    with pytest.raises(ValueError) as refusal:
        parse_flags({"head_count": raw})
    assert str(refusal.value) == f"shuf: invalid line count: '{raw}'"


@pytest.mark.parametrize("raw,count", [("05", 5), ("+5", 5), ("0", 0)])
def test_shuf_head_count_accepts_what_gnu_accepts(raw, count):
    """GNU reads a leading zero as decimal, `+5` as 5, and `0` as valid."""
    assert parse_flags({"head_count": raw}).count == count


@pytest.mark.parametrize("raw", ["-1", "-0"])
def test_shuf_head_count_refuses_a_leading_minus(raw):
    """To GNU shuf, `-` is an invalid character rather than a sign.

    It is rejected while scanning, so the message carries no
    `: Numerical result out of range` clause the way `nl -w` does.
    """
    with pytest.raises(ValueError) as refusal:
        parse_flags({"head_count": raw})
    assert str(refusal.value) == f"shuf: invalid line count: '{raw}'"


def test_shuf_head_count_zero_prints_nothing():
    """GNU `shuf -n 0` succeeds with zero bytes, not one bare separator."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "shuf -e -n 0 a b c", cwd="/data")
    assert io.exit_code == 0
    assert _bytes(stdout) == b""


def test_shuf_head_count_one_still_works():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "shuf -e -n 1 a b c", cwd="/data")
    assert io.exit_code == 0
    assert len(_bytes(stdout).strip().decode().split("\n")) == 1


@pytest.mark.parametrize("raw", ["1-x", "x-3", "abc", "3-1", "-2-1", "1", ""])
def test_shuf_input_range_refusal_is_uniform(raw):
    """GNU answers every malformed `-i` with one message, quoting it whole.

    Non-numeric bounds, a decreasing range, a negative low bound, a
    missing dash and an empty value all read the same. shuf has no
    decreasing-range diagnostic of its own, so cut's is not borrowed.
    """
    with pytest.raises(ValueError) as refusal:
        asyncio.run(
            shuf([], [], read_bytes=_unused_read_bytes, input_range=raw))
    assert str(refusal.value) == f"shuf: invalid input range: '{raw}'"


def test_shuf_input_range_single_element_is_valid():
    """GNU `-i 2-2` is a one-element range, not a degenerate one."""
    rendered, io = asyncio.run(
        shuf([], [], read_bytes=_unused_read_bytes, input_range="2-2"))
    assert io.exit_code == 0
    assert rendered == b"2\n"


def test_shuf_input_range_stays_valid():
    rendered, io = asyncio.run(
        shuf([], [], read_bytes=_unused_read_bytes, input_range="1-3"))
    assert io.exit_code == 0
    assert sorted(rendered.decode().strip().split("\n")) == ["1", "2", "3"]


# A trailing newline in a value is refused, and this is the shape of bug
# only python has: `$` also matches immediately BEFORE a trailing
# newline, so `re.match(r"^\+?[0-9]+$", "2\n")` SUCCEEDS and read
# `shuf -n $'2\n'` as the valid count 2. GNU's scanner stops at the first
# non-digit and refuses both flags (ground truth NL2-A), as the
# TypeScript twin always did, so the fix is `fullmatch`. The value is
# rendered through gnulib `quote()`, so the newline is the two characters
# `\n` and not the byte (NL3-A).
@pytest.mark.parametrize("raw,quoted", [("2\n", "2\\n"), ("1\n2", "1\\n2"),
                                        ("0\n", "0\\n"), ("2\r", "2\\r"),
                                        ("2\x01", "2\\001")])
def test_shuf_head_count_refuses_a_trailing_newline(raw, quoted):
    with pytest.raises(ValueError) as refusal:
        parse_flags({"head_count": raw})
    assert str(refusal.value) == f"shuf: invalid line count: '{quoted}'"


@pytest.mark.parametrize("raw,quoted", [("1-3\n", "1-3\\n"),
                                        ("1-3\n5", "1-3\\n5"),
                                        ("2-2\n", "2-2\\n")])
def test_shuf_input_range_refuses_a_trailing_newline(raw, quoted):
    with pytest.raises(ValueError) as refusal:
        asyncio.run(
            shuf([], [], read_bytes=_unused_read_bytes, input_range=raw))
    assert str(refusal.value) == f"shuf: invalid input range: '{quoted}'"


@pytest.mark.parametrize("raw", ["2", "+2", "0"])
def test_shuf_head_count_without_a_newline_is_still_accepted(raw):
    """The control: the anchoring must not refuse a clean value."""
    assert parse_flags({"head_count": raw}) is not None


# LEADING C whitespace is SKIPPED, because that is `strtoumax`'s own
# skip, while trailing whitespace is garbage. `\s` would be wrong for the
# same reason as in nl: python calls 0x1c-0x1f whitespace and GNU does
# not. Ground truth NL3-C.
@pytest.mark.parametrize(
    "raw", [" 2", "\t2", "\n2", "\x0b2", "\f2", "\r2", "  2", " +2"])
def test_shuf_head_count_skips_leading_c_whitespace(raw):
    assert parse_flags({"head_count": raw}) is not None


@pytest.mark.parametrize("raw,quoted", [("2 ", "2 "), (" -2", " -2"),
                                        ("+ 2", "+ 2"), ("\x1c2", "\\0342")])
def test_shuf_head_count_refuses_the_rest_of_the_prefix(raw, quoted):
    """`-n` is unsigned, so ` -2` is refused where nl's `-v` accepts it."""
    with pytest.raises(ValueError) as refusal:
        parse_flags({"head_count": raw})
    assert str(refusal.value) == f"shuf: invalid line count: '{quoted}'"


# `-i` splits at the FIRST dash and scans each bound on its own, so a `+`
# and a leading blank ride on either bound independently. Every row
# measured against GNU (ground truth NL3-D).
@pytest.mark.parametrize("raw,bounds", [
    ("1-3", (1, 3)),
    ("+1-3", (1, 3)),
    ("1-+3", (1, 3)),
    ("+1-+3", (1, 3)),
    (" +1-3", (1, 3)),
    ("1- 3", (1, 3)),
    ("+0-0", (0, 0)),
    ("10-20", (10, 20)),
    ("2-2", (2, 2)),
    ("01-03", (1, 3)),
])
def test_shuf_input_range_accepts_a_bound_prefix(raw, bounds):
    assert parse_input_range(raw) == bounds


@pytest.mark.parametrize("raw", [
    "-1-3",
    "1--3",
    "++1-3",
    "1-2-3",
    "1-3-",
    " 1 - 3 ",
    "1 -3",
    "-",
    "1-",
    "-3",
    "3-1",
    "1-3\n",
    "abc",
    "1",
    "",
])
def test_shuf_input_range_refuses_every_other_shape(raw):
    """A `-` is never a sign, and shuf has one message for all of it."""
    assert parse_input_range(raw) is None


def test_shuf_builder_returns_a_refusal_rather_than_raising():
    """Every sibling generic catches its own ValueError; shuf did not.

    Inside a workspace the executor's catch-all produced identical
    bytes, so this is invisible there -- but a direct call raised on
    python where the TypeScript `shufGeneric` returned an IOResult. The
    bytes and the exit code must not move.
    """
    ws, _ = _ws()
    for cmd, message in [
        ("shuf -n abc", b"shuf: invalid line count: 'abc'\n"),
        ("shuf -i 1-x", b"shuf: invalid input range: '1-x'\n"),
    ]:
        stdout, io = _run_raw(ws, cmd, stdin=b"a\n")
        assert io.exit_code == 1
        assert not _bytes(stdout)
        assert io.stderr == message


def test_shuf_no_write_op_is_not_swallowed_by_that_catch():
    """The one ValueError the builder must let through.

    A `-o` on a backend with no write op is a wiring fault, and the
    TypeScript twin throws a bare Error for it where it returns an
    IOResult for every user-facing refusal. Named as a constant so the
    catch and the raise cannot drift apart.
    """
    assert NO_WRITE_OP == "shuf: backend provides no write op"
    with pytest.raises(ValueError, match="backend provides no write op"):
        asyncio.run(
            shuf([], [],
                 read_bytes=_unused_read_bytes,
                 stdin=b"a\n",
                 output=PathSpec(resource_path="o.txt",
                                 virtual="/o.txt",
                                 directory="/",
                                 resolved=True),
                 write_bytes=None))
