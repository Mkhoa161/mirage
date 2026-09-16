import time

import pytest

from mirage.workspace.executor.builtins.sleep import handle_sleep


# Measured on coreutils 9.4: the missing operand is the same
# `usage (EXIT_FAILURE)` refusal the invalid interval is, so it carries
# the same Try-help line.
@pytest.mark.asyncio
async def test_sleep_missing_operand_exits_1():
    _, io, node = await handle_sleep([])
    assert io.exit_code == 1
    assert io.stderr == (b"sleep: missing operand\n"
                         b"Try 'sleep --help' for more information.\n")
    assert node.exit_code == 1


# sleep declares no options and reads the line through a real
# getopt_long loop, so a dash word it does not know is the option
# refusal and never the interval one, wherever it sits (measured on 9.4:
# `sleep --zzz 0` and `sleep 0 --zzz` both report the option).
@pytest.mark.asyncio
@pytest.mark.parametrize("args", [["--zzz"], ["--zzz", "0"], ["0", "--zzz"]])
async def test_sleep_unknown_long_option_exits_1(args):
    _, io, node = await handle_sleep(args)
    assert io.exit_code == 1
    assert io.stderr == (b"sleep: unrecognized option '--zzz'\n"
                         b"Try 'sleep --help' for more information.\n")
    assert node.exit_code == 1


# A short one names the offending character, GNU's other wording.
@pytest.mark.asyncio
async def test_sleep_unknown_short_option_names_the_character():
    _, io, _ = await handle_sleep(["-Q"])
    assert io.stderr == (b"sleep: invalid option -- 'Q'\n"
                         b"Try 'sleep --help' for more information.\n")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw",
    ["abc", "-1", "inf", "Infinity", "nan", "NaN", "0x10", "1_0", "1e309", ""])
async def test_sleep_invalid_interval_exits_1(raw):
    _, io, node = await handle_sleep([raw])
    assert io.exit_code == 1
    assert io.stderr == (
        f"sleep: invalid time interval '{raw}'\n"
        f"Try 'sleep --help' for more information.\n").encode()
    assert node.exit_code == 1


# The operand is named through gnulib's `quote()`, like every other
# coreutils operand diagnostic: measured on 9.4, `sleep -- <e-acute>` is
# `sleep: invalid time interval '\303\251'`.
@pytest.mark.asyncio
@pytest.mark.parametrize("raw,escaped", [("xé", r"x\303\251"), ("x\r", r"x\r"),
                                         ("--zzz=é", r"--zzz=\303\251")])
async def test_sleep_invalid_interval_quotes_the_word(raw, escaped):
    _, io, _ = await handle_sleep(["--", raw])
    assert io.stderr == (
        f"sleep: invalid time interval '{escaped}'\n"
        f"Try 'sleep --help' for more information.\n").encode()


@pytest.mark.asyncio
@pytest.mark.parametrize("raw", ["0", "0.", ".01", "+0.01", "1e-3"])
async def test_sleep_valid_interval_exits_0(raw):
    _, io, node = await handle_sleep([raw])
    assert io.exit_code == 0
    assert not io.stderr
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_sleep_zero_returns_promptly():
    start = time.monotonic()
    _, io, _ = await handle_sleep(["0"])
    assert io.exit_code == 0
    assert time.monotonic() - start < 0.05
