// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { quoteText } from '../../../../commands/quote.ts'
import { NUMERIC_SHORT } from '../../../../commands/spec/constants.ts'
import { unknownOptionError, usageHint } from '../../../../commands/spec/usage.ts'
import { IOResult } from '../../../../io/types.ts'
import { sleep } from '../../../abort.ts'
import { ExecutionNode } from '../../../types.ts'
import { SLEEP_INTERVAL } from './constants.ts'
import type { BuiltinCall, Result } from '../types.ts'

/**
 * sleep's operands, and the first option it does not declare.
 *
 * coreutils sleep declares no options of its own and reads the line through a
 * real getopt_long loop (`parse_gnu_standard_options_only`), so it refuses a
 * dash-leading word wherever that word sits: measured on 9.4, `sleep --zzz 0`
 * and `sleep 0 --zzz` both report the option and neither reports the interval.
 * `--` ends the scan, which is what makes `sleep -- '--zzz=é'` an interval
 * diagnostic instead of an option one, and a `-<digits>` word stays an operand
 * -- mirage's NUMERIC_SHORT rule, which every command shares, and the reason
 * `sleep -1` names the interval where GNU names the option letter.
 *
 * The returned option is the whole token for a long spelling and the offending
 * letter for a short one, the split `unknownOptionError` already words.
 *
 * `_sleep_operands` in sleep.py is the twin.
 */
function sleepOperands(args: string[]): [string[], string | null] {
  const operands: string[] = []
  for (const [index, arg] of args.entries()) {
    if (arg === '--') {
      operands.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith('-') && arg.length > 1 && !NUMERIC_SHORT.test(arg)) {
      return [operands, arg.startsWith('--') ? arg : (arg[1] ?? arg)]
    }
    operands.push(arg)
  }
  return [operands, null]
}

export async function handleSleep(args: string[], signal?: AbortSignal): Promise<Result> {
  const [operands, badOption] = sleepOperands(args)
  if (badOption !== null) {
    const [message, code] = unknownOptionError('sleep', badOption)
    return [
      null,
      new IOResult({ exitCode: code, stderr: message }),
      new ExecutionNode({ command: 'sleep', exitCode: code }),
    ]
  }
  const raw = operands[0]
  if (raw === undefined) {
    // Missing operand is the same `usage (EXIT_FAILURE)` refusal the
    // invalid-interval one is, so it carries the same Try-help line (measured
    // on 9.4: `sleep` is two lines, not one).
    const err = new TextEncoder().encode(`sleep: missing operand\n${usageHint('sleep')}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  // "1e309" passes the regex but overflows to Infinity, so check both.
  const seconds = SLEEP_INTERVAL.test(raw) ? Number(raw) : Infinity
  if (!Number.isFinite(seconds)) {
    // coreutils sleep refuses an operand through `usage (EXIT_FAILURE)`, so
    // the diagnostic carries the Try-help line, and the operand goes through
    // gnulib's `quote()` like every other coreutils operand diagnostic
    // (measured on 9.4: `sleep abc` is two lines, and `sleep -- é` names
    // `'\303\251'`).
    const err = new TextEncoder().encode(
      `sleep: invalid time interval '${quoteText(raw)}'\n${usageHint('sleep')}\n`,
    )
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'sleep', exitCode: 1 }),
    ]
  }
  await sleep(seconds * 1000, signal)
  return [null, new IOResult(), new ExecutionNode({ command: 'sleep', exitCode: 0 })]
}

/** The `sleep` arm; the abort signal ends the wait early. */
export async function sleepBuiltin(call: BuiltinCall): Promise<Result> {
  return handleSleep([...call.argv.args], call.signal)
}
