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
import math

from mirage.commands.quote import quote_text
from mirage.commands.spec.constants import NUMERIC_SHORT
from mirage.commands.spec.usage import unknown_option_error, usage_hint
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.workspace.abort import cancellable_sleep
from mirage.workspace.executor.builtins.sleep.constants import SLEEP_INTERVAL
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.types import ExecutionNode


def _sleep_operands(args: list[str]) -> tuple[list[str], str | None]:
    """sleep's operands, and the first option it does not declare.

    coreutils sleep declares no options of its own and reads the line
    through a real getopt_long loop
    (``parse_gnu_standard_options_only``), so it refuses a dash-leading
    word wherever that word sits: measured on 9.4, `sleep --zzz 0` and
    `sleep 0 --zzz` both report the option and neither reports the
    interval. `--` ends the scan, which is what makes
    `sleep -- '--zzz=é'` an interval diagnostic instead of an option
    one, and a `-<digits>` word stays an operand -- mirage's
    NUMERIC_SHORT rule, which every command shares, and the reason
    `sleep -1` names the interval where GNU names the option letter.

    Args:
        args (list[str]): words after the command name, as typed.

    Returns:
        tuple[list[str], str | None]: the operands, and the offending
            token (long) or option letter (short), or None when every
            dash word was one sleep accepts.
    """
    operands: list[str] = []
    for index, arg in enumerate(args):
        if arg == "--":
            operands.extend(args[index + 1:])
            break
        if (arg.startswith("-") and len(arg) > 1
                and not NUMERIC_SHORT.match(arg)):
            # GNU names the whole token for a long option and the first
            # offending character for a short one, which is the split
            # unknown_option_error already words.
            return operands, arg if arg.startswith("--") else arg[1]
        operands.append(arg)
    return operands, None


async def handle_sleep(
    args: list[str],
    cancel: asyncio.Event | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    operands, bad_option = _sleep_operands(args)
    if bad_option is not None:
        message, code = unknown_option_error("sleep", bad_option)
        return None, IOResult(exit_code=code,
                              stderr=message), ExecutionNode(command="sleep",
                                                             exit_code=code)
    if not operands:
        # Missing operand is the same `usage (EXIT_FAILURE)` refusal the
        # invalid-interval one is, so it carries the same Try-help line
        # (measured on 9.4: `sleep` is two lines, not one).
        err = (f"sleep: missing operand\n{usage_hint('sleep')}\n").encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="sleep",
                                                         exit_code=1)
    raw = operands[0]
    # "1e309" passes the regex but overflows to inf, so check both.
    seconds = float(raw) if SLEEP_INTERVAL.fullmatch(raw) else math.inf
    if not math.isfinite(seconds):
        # coreutils sleep refuses an operand through `usage
        # (EXIT_FAILURE)`, so the diagnostic carries the Try-help line,
        # and the operand goes through gnulib's `quote()` like every
        # other coreutils operand diagnostic (measured on 9.4:
        # `sleep abc` is two lines, and `sleep -- <e-acute>` names
        # `'\303\251'`).
        err = (f"sleep: invalid time interval '{quote_text(raw)}'\n"
               f"{usage_hint('sleep')}\n").encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="sleep",
                                                         exit_code=1)
    await cancellable_sleep(seconds, cancel)
    return None, IOResult(), ExecutionNode(command="sleep", exit_code=0)


async def sleep_builtin(call: BuiltinCall) -> Result:
    """The ``sleep`` arm.

    Args:
        call (BuiltinCall): the invocation; its cancel event ends the
            wait early.
    """
    return await handle_sleep(list(call.argv.args), cancel=call.cancel)
