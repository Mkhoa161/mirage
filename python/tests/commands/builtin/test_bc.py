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


def test_bc_add():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "bc", stdin=b"2+3")
    assert _bytes(stdout).strip() == b"5"


def test_bc_multiply():
    ws, _ = _ws()
    stdout, _ = _run_raw(ws, "bc", stdin=b"6*7")
    assert _bytes(stdout).strip() == b"42"


def _stderr_text(io):
    err = io.stderr
    if err is None:
        return ""
    return err.decode() if isinstance(err, bytes) else str(err)


def _out(cmd, stdin):
    ws, _ = _ws()
    stdout, io = _run_raw(ws, cmd, stdin=stdin)
    return (b"" if stdout is None else _bytes(stdout)), io


def test_bc_default_scale_is_zero_so_division_truncates():
    # GNU: default scale is 0, so `7/2` is 3 and `-7/2` is -3 --
    # truncation toward zero, not floor.
    assert _out("bc", b"scale\n")[0] == b"0\n"
    assert _out("bc", b"7/2\n")[0] == b"3\n"
    assert _out("bc", b"-7/2\n")[0] == b"-3\n"


def test_bc_modulo_takes_the_dividend_sign():
    assert _out("bc", b"7%2\n")[0] == b"1\n"
    assert _out("bc", b"-7%2\n")[0] == b"-1\n"


def test_bc_scale_assignment_pads_the_quotient():
    # GNU prints the trailing zero: `3.50`, not `3.5`.
    assert _out("bc", b"scale=2; 7/2\n")[0] == b"3.50\n"


def test_bc_sum_keeps_the_wider_operand_scale():
    # `0.1+0.2` is `.3` at the default scale of 0, because addition keeps
    # its operands' scale -- and GNU omits the leading zero.
    assert _out("bc", b"0.1+0.2\n")[0] == b".3\n"


def test_bc_power_and_parentheses():
    assert _out("bc", b"2^10\n")[0] == b"1024\n"
    assert _out("bc", b"(1+2)*3\n")[0] == b"9\n"


def test_bc_sqrt_needs_no_math_library():
    # GNU has sqrt built in; only s/c/a/l/e come from -l.
    assert _out("bc", b"sqrt(4)\n")[0] == b"2\n"


def test_bc_divide_by_zero_is_non_fatal_and_keeps_evaluating():
    # GNU prints the runtime error on stderr, still evaluates the next
    # statement, and exits 0.
    stdout, io = _out("bc", b"1/0\n2+2\n")
    assert stdout == b"4\n"
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Divide by zero\n")
    assert io.exit_code == 0


def test_bc_divide_by_zero_alone_prints_nothing_on_stdout():
    stdout, io = _out("bc", b"1/0\n")
    assert stdout == b""
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Divide by zero\n")
    assert io.exit_code == 0


def test_bc_modulo_by_zero_has_its_own_wording():
    stdout, io = _out("bc", b"1%0\n")
    assert stdout == b""
    assert _stderr_text(io) == (
        "Runtime error (func=(main), adr=3): Modulo by zero\n")
    assert io.exit_code == 0


def test_bc_math_library_sets_scale_to_twenty():
    # -l loads the math library, which sets scale to 20, so `7/2` stops
    # truncating.
    assert _out("bc -l", b"scale\n")[0] == b"20\n"
    assert _out("bc -l", b"7/2\n")[0] == b"3.50000000000000000000\n"


def test_bc_math_library_exact_zero_is_not_padded():
    # GNU prints a bare `0` for an exact zero whatever the scale, so
    # `s(0)` and `l(1)` are `0` rather than `0.000...`.
    assert _out("bc -l", b"s(0)\n")[0] == b"0\n"
    assert _out("bc -l", b"l(1)\n")[0] == b"0\n"


def test_bc_math_library_exact_one_is_padded():
    assert _out("bc -l", b"c(0)\n")[0] == b"1.00000000000000000000\n"


def test_bc_math_library_irrationals_are_float64_limited():
    # These are the three ground-truth values float64 cannot reach.
    # GNU (arbitrary precision) prints:
    #   sqrt(2) 1.41421356237309504880
    #   a(1)     .78539816339744830961
    #   e(1)    2.71828182845904523536
    # Both hosts share one float64 model (TypeScript has no bigdecimal
    # in-tree), so both print these instead; the leading 16 digits are
    # the ones float64 can carry.
    assert _out("bc -l", b"sqrt(2)\n")[0] == b"1.41421356237309514547\n"
    assert _out("bc -l", b"a(1)\n")[0] == b".78539816339744827900\n"
    assert _out("bc -l", b"e(1)\n")[0] == b"2.71828182845904509080\n"


def test_bc_does_not_evaluate_python():
    # The regression this rewrite exists for: `bc` used to run eval() on
    # agent-typed text, so any python expression executed.
    stdout, io = _out("bc", b'__import__("os").getcwd()\n')
    assert stdout == b""
    assert io.exit_code == 1
    assert "unexpected character" in _stderr_text(io)


def test_bc_rejects_math_functions_without_the_library():
    stdout, io = _out("bc", b"s(0)\n")
    assert io.exit_code == 1
    assert "identifiers not allowed without -l flag" in _stderr_text(io)
