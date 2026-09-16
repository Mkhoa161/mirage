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

import { versionLine } from '../../../../commands/config.ts'
import { quoteText } from '../../../../commands/quote.ts'
import { specOf } from '../../../../commands/spec/index.ts'
import { NUMERIC_SHORT } from '../../../../commands/spec/constants.ts'
import { renderHelp } from '../../../../commands/spec/help.ts'
import {
  ambiguousOptionError,
  unexpectedValueError,
  unknownOptionError,
  usageHint,
} from '../../../../commands/spec/usage.ts'
import { yieldBytes } from '../../../../io/stream.ts'
import { IOResult } from '../../../../io/types.ts'
import { sleep } from '../../../abort.ts'
import { ExecutionNode } from '../../../types.ts'
import { SLEEP_INTERVAL } from './constants.ts'
import type { BuiltinCall, Result } from '../types.ts'

// The only two options coreutils sleep declares, through gnulib's
// `parse_gnu_standard_options_only`. They share no prefix, so an abbreviation
// of either resolves and neither can ever be ambiguous.
const STANDARD_OPTIONS = ['--help', '--version'] as const

/**
 * The standard options a long spelling names, declaration order.
 *
 * getopt_long takes an exact word outright and otherwise keeps every candidate
 * the word prefixes, so `sleep --h` is one match (help, exit 0) and
 * `sleep --=x` is an empty name that prefixes both, which GNU refuses as
 * ambiguous. Measured on 9.7. `_standard_matches` in sleep.py is the twin.
 */
function standardMatches(name: string): string[] {
  const exact = STANDARD_OPTIONS.find((word) => word === name)
  if (exact !== undefined) return [exact]
  return STANDARD_OPTIONS.filter((word) => word.startsWith(name))
}

/**
 * sleep's answer to `--help` or `--version`: stdout, exit 0.
 *
 * The page is the spec's, rendered by the one renderer every other mirage
 * command answers `--help` with (commands/config.ts), so the two cannot drift.
 */
function standardResponse(option: string): Result {
  const text = option === '--help' ? renderHelp('sleep', specOf('sleep')) : versionLine('sleep')
  return [
    yieldBytes(new TextEncoder().encode(text)),
    new IOResult(),
    new ExecutionNode({ command: 'sleep', exitCode: 0 }),
  ]
}

/**
 * sleep's operands, and the first dash word that is not one.
 *
 * coreutils sleep declares only gnulib's two standard options and reads the
 * line through a real getopt_long loop (`parse_gnu_standard_options_only`), so
 * it stops at a dash-leading word wherever that word sits: measured on 9.4,
 * `sleep --zzz 0` and `sleep 0 --zzz` both report the option and neither
 * reports the interval. The caller decides what that word means, since a
 * `--help`/`--version` spelling is an answer rather than a refusal. `--` ends
 * the scan, which is what makes `sleep -- '--zzz=é'` an interval diagnostic
 * instead of an option one, and a `-<digits>` word stays an operand --
 * mirage's NUMERIC_SHORT rule, which every command shares, and the reason
 * `sleep -1` names the interval where GNU names the option letter.
 *
 * The returned word is the whole token for a long spelling and the offending
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
    // The scan stops at the first dash word, and that word decides the whole
    // line: `sleep --help --zzz` is help and `sleep --zzz --help` is the
    // refusal (measured on 9.7). A long spelling is first offered to the two
    // standard options, which are real getopt_long options, so an abbreviation
    // resolves and a value on one is refused for the VALUE rather than as an
    // unknown option (`sleep --hel=x` is `option '--help' doesn't allow an
    // argument`).
    const eq = badOption.indexOf('=')
    const name = eq === -1 ? badOption : badOption.slice(0, eq)
    const matches = name.startsWith('--') ? standardMatches(name) : []
    const sole = matches[0]
    if (sole !== undefined && matches.length === 1 && eq === -1) {
      return standardResponse(sole)
    }
    // `--=x` is an empty long name, which prefixes both, and getopt_long
    // quotes the WHOLE token here where the doesn't-allow-an-argument refusal
    // quotes the canonical spelling.
    const [message, code] =
      matches.length > 1
        ? ambiguousOptionError('sleep', badOption, matches)
        : sole !== undefined
          ? unexpectedValueError('sleep', sole)
          : unknownOptionError('sleep', badOption)
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
