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

from mirage.commands.builtin.generic.expand import parse_flags
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


def test_expand_default_tab():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "expand", stdin=b"a\tb")
    assert _bytes(stdout) == b"a       b"


def test_expand_t4():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "expand -t 4", stdin=b"a\tb")
    assert _bytes(stdout) == b"a   b"


def test_unexpand_t4():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "unexpand -a -t 4", stdin=b"    hello")
    assert _bytes(stdout) == b"\thello"


def test_expand_tab_size_quotes_only_the_bad_remainder():
    """GNU reports `--tabs=8x` as 'x', not as '8x'."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expand -t 8x", stdin=b"a\tb\n")
    assert io.exit_code == 1
    assert io.stderr == (
        b"expand: tab size contains invalid character(s): 'x'\n")
    assert not stdout


def test_expand_tab_size_with_no_digits_quotes_the_whole_argument():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expand --tabs=abc", stdin=b"a\tb\n")
    assert io.exit_code == 1
    assert io.stderr == (
        b"expand: tab size contains invalid character(s): 'abc'\n")
    assert not stdout


@pytest.mark.parametrize("raw", [" 5 ", "1_0", "0x10", "1e3", "-4"])
def test_expand_tab_size_is_as_strict_as_gnu(raw):
    """GNU refuses what `int()` accepts.

    Surrounding blanks and `_` are read whole by `int()`; GNU refuses
    each. `-` is not a sign to expand but the first invalid character,
    so `-4` is refused too.
    """
    with pytest.raises(ValueError) as refusal:
        parse_flags({"tabs": raw})
    assert str(refusal.value).startswith(
        "expand: tab size contains invalid character(s): '")


@pytest.mark.parametrize("raw,quoted", [("-4", "-4"), ("8x", "x"),
                                        ("abc", "abc"), ("+x", "x")])
def test_expand_quotes_from_the_first_unparseable_character(raw, quoted):
    """GNU quotes from where the scan stopped, not "after the digits".

    `8x` stops at `x` and quotes only it, while `-4` stops at position 0
    and quotes the whole argument. A leading `+` is consumed as a sign,
    so `+x` stops at `x`.
    """
    with pytest.raises(ValueError) as refusal:
        parse_flags({"tabs": raw})
    assert str(refusal.value) == (
        f"expand: tab size contains invalid character(s): '{quoted}'")


@pytest.mark.parametrize("raw", ["+4", "4"])
def test_expand_tab_size_accepts_a_leading_plus(raw):
    """GNU reads `+4` as 4 on every integer flag value."""
    assert parse_flags({"tabs": raw}).tabsize == 4


def test_expand_empty_tab_list_is_the_default_size():
    """`--tabs=''` is zero tab stops, which leaves GNU on its default 8."""
    assert parse_flags({"tabs": ""}).tabsize == 8
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expand -t ''", stdin=b"a\tb")
    assert io.exit_code == 0
    assert io.stderr in (None, b"")
    assert _bytes(stdout) == b"a       b"


def test_expand_tab_size_leading_zero_is_plain_decimal():
    """A control: a too-strict guard would refuse `04` too."""
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expand -t 04", stdin=b"a\tb")
    assert io.exit_code == 0
    assert _bytes(stdout) == b"a   b"
