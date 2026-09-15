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

from mirage.commands.builtin.general.expr import ExprError, _expr_eval
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


def test_expr_add():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expr 3 + 4")
    assert _bytes(stdout).strip() == b"7"
    assert io.exit_code == 0


def test_expr_compare():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expr 5 '>' 3")
    assert _bytes(stdout).strip() == b"1"
    assert io.exit_code == 0


def _stderr_text(io):
    err = io.stderr
    if err is None:
        return ""
    return err.decode() if isinstance(err, bytes) else str(err)


def _out(cmd):
    ws, _ = _ws()
    stdout, io = _run_raw(ws, cmd)
    return (b"" if stdout is None else _bytes(stdout)), io


def test_expr_division_truncates_toward_zero():
    # GNU truncates, python's `//` floors: `-10 / 3` is -3, not -4.
    assert _expr_eval(["-10", "/", "3"]) == ("-3", 0)
    assert _expr_eval(["10", "/", "-3"]) == ("-3", 0)
    assert _expr_eval(["-10", "/", "-3"]) == ("3", 0)
    assert _expr_eval(["-7", "/", "2"]) == ("-3", 0)


def test_expr_remainder_takes_the_dividend_sign():
    # GNU: `-10 % 3` is -1 where python answers 2, and `10 % -3` is 1
    # where python answers -2.
    assert _expr_eval(["-10", "%", "3"]) == ("-1", 0)
    assert _expr_eval(["10", "%", "-3"]) == ("1", 0)
    assert _expr_eval(["-7", "%", "2"]) == ("-1", 0)


def test_expr_exits_one_when_the_result_is_zero():
    # POSIX: exit 1 means "succeeded, the value was 0 or empty". Only
    # exit 2 is an error, so the two must not be conflated.
    assert _expr_eval(["-1", "/", "2"]) == ("0", 1)
    assert _expr_eval(["1", "/", "-2"]) == ("0", 1)


def test_expr_is_arbitrary_precision():
    assert _expr_eval(["9223372036854775807", "+",
                       "1"]) == ("9223372036854775808", 0)


def test_expr_accepts_leading_zeros_as_decimal():
    # `05` is decimal 5, not octal, and `00` / `-0` are zero.
    assert _expr_eval(["05", "+", "1"]) == ("6", 0)
    assert _expr_eval(["00", "+", "1"]) == ("1", 0)
    assert _expr_eval(["-0", "+", "1"]) == ("1", 0)


def test_expr_rejects_operands_python_int_would_accept():
    # GNU's operand grammar is narrower than `int()`: no explicit plus,
    # no surrounding whitespace, no digit separator, no hex, no float.
    for operand in ("+5", " 5 ", " 5", "5 ", "1_0", "0x10", "1e3", "abc"):
        with pytest.raises(ExprError) as caught:
            _expr_eval([operand, "+", "1"])
        assert str(caught.value) == "expr: non-integer argument"


def test_expr_comparison_falls_back_to_strings_for_a_bad_operand():
    # `+5` is not an integer operand, so GNU compares the two as
    # strings and `+5` != `5`.
    assert _expr_eval(["+5", "=", "5"]) == ("0", 1)


def test_expr_zero_divisor_raises_gnu_wording():
    for op in ("/", "%"):
        with pytest.raises(ExprError) as caught:
            _expr_eval(["1", op, "0"])
        assert str(caught.value) == "expr: division by zero"


def test_expr_division_by_zero_exits_two_with_empty_stdout():
    # GNU: nothing on stdout, one lower-case line on stderr with no
    # trailing period, exit 2.
    stdout, io = _out("expr 1 '/' 0")
    assert stdout == b""
    assert _stderr_text(io) == "expr: division by zero\n"
    assert io.exit_code == 2


def test_expr_modulo_by_zero_uses_the_same_message():
    stdout, io = _out("expr 1 '%' 0")
    assert stdout == b""
    assert _stderr_text(io) == "expr: division by zero\n"
    assert io.exit_code == 2


def test_expr_non_integer_operand_exits_two_with_empty_stdout():
    stdout, io = _out("expr '+5' + 1")
    assert stdout == b""
    assert _stderr_text(io) == "expr: non-integer argument\n"
    assert io.exit_code == 2
