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

from mirage.commands.builtin.generic.shuf import parse_flags, shuf
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
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
