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

import { specOf } from '../../spec/builtins.ts'
import { FlagView, type FlagValue } from '../../spec/types.ts'
import { quoteText } from '../../quote.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function splitLinesNoTrailing(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text
  return stripped === '' ? [] : stripped.split('\n')
}

function shuffleInPlace(arr: string[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i] ?? ''
    arr[i] = arr[j] ?? ''
    arr[j] = tmp
  }
}

function choicesWithReplacement(items: readonly string[], k: number): string[] {
  if (items.length === 0) return []
  const out: string[] = []
  for (let i = 0; i < k; i++) {
    out.push(items[Math.floor(Math.random() * items.length)] ?? '')
  }
  return out
}

function processItems(items: string[], repeat: boolean, nFlag: number | null): string[] {
  if (repeat) {
    const count = nFlag ?? items.length
    return choicesWithReplacement(items, count)
  }
  shuffleInPlace(items)
  if (nFlag !== null) return items.slice(0, nFlag)
  return items
}

// GNU accepts a leading `+` and reads `+2` as 2, and `0` is a valid head
// count. A `-` is not a sign here but an invalid character, so `-1` is refused
// and quoted whole with no out-of-range clause: shuf rejects the sign while
// scanning rather than range-checking a parsed negative. Anchored at both ends
// so a trailing newline (`shuf -n $'2\n'`) is refused, which is what the
// python twin's `fullmatch` answers.
//
// The leading run of C whitespace is `strtoumax`'s own skip and is real GNU
// behavior: `shuf -n ' 2'`, `$'\t2'`, `$'\n2'` and `' +2'` are all accepted
// while `'2 '` is refused. The class is spelled out rather than written `\s`
// because it is C `isspace`, and JavaScript's `\s` also matches every Unicode
// space. Measured, ground truth NL3-C.
const C_SPACE = '[ \\t\\n\\v\\f\\r]*'
const LINE_COUNT = new RegExp(`^${C_SPACE}\\+?[0-9]+$`)

// One `-i` bound, scanned on its own. See parseInputRange.
const BOUND = new RegExp(`^${C_SPACE}\\+?[0-9]+$`)

// GNU's `-i LO-HI`, read the way GNU reads it.
//
// Split at the FIRST dash and scan each side on its own, which is what
// `strchr(optarg, '-')` plus two `strtoumax` calls amount to. Doing it as one
// regex over the whole argument gets three shapes wrong: `-i +1-3` and
// `-i 1-+3` carry a `+` on either bound independently, `-i '1- 3'` puts the
// blank on the HIGH bound's prefix and is accepted, and `-i '1 -3'` is refused
// because that same blank is trailing garbage on the LOW one.
//
// A `-` is never a sign here, so an empty low bound (`-i -1-3`, where the
// first dash is at index 0) and a negative high bound (`-i 1--3`) are both
// refused, as is a second dash anywhere (`-i 1-2-3`). Returns null when GNU
// refuses the argument -- including when the range decreases, since shuf has
// only the one message for all of it. Measured, ground truth NL3-D.
//
// `parse_input_range` in shuf.py is the twin.
export function parseInputRange(raw: string): [number, number] | null {
  const dash = raw.indexOf('-')
  if (dash < 0) return null
  const lowRaw = raw.slice(0, dash)
  const highRaw = raw.slice(dash + 1)
  if (!BOUND.test(lowRaw) || !BOUND.test(highRaw)) return null
  const low = Number.parseInt(lowRaw, 10)
  const high = Number.parseInt(highRaw, 10)
  if (low > high) return null
  return [low, high]
}

export interface ShufFlags {
  readonly count: number | null
  readonly echo: boolean
  readonly zeroTerminated: boolean
  readonly withReplacement: boolean
  readonly inputRange: string | null
  // The raw `-o` word. The python executor promotes a PATH-typed flag to a
  // PathSpec and reads it with as_paths; this bag carries the resolved
  // virtual-path string, so asStr is the twin and the PathSpec is built at
  // the call site.
  readonly output: string | null
}

// Read shuf's flags once, refusing a head count GNU refuses.
//
// GNU quotes the WHOLE `-n` argument, not just the unparsed remainder the way
// expand and cut do, and never appends an out-of-range clause to it.
// Pre-validated the way head/tail do it, so the parseInt below cannot hand
// back a prefix or NaN. Returns the stderr text instead of the struct when
// GNU refuses the line, the shape every sibling generic's parseFlags uses.
export function parseFlags(flags: Record<string, FlagValue>): ShufFlags | string {
  const fl = new FlagView(flags, specOf('shuf'))
  const countValue = fl.asStr('head_count')
  if (countValue !== undefined && !LINE_COUNT.test(countValue)) {
    return `shuf: invalid line count: '${quoteText(countValue)}'\n`
  }
  return {
    count: countValue === undefined ? null : Number.parseInt(countValue, 10),
    echo: fl.asBool('echo'),
    zeroTerminated: fl.asBool('zero_terminated'),
    withReplacement: fl.asBool('repeat'),
    inputRange: fl.asStr('input_range') ?? null,
    output: fl.asStr('output') ?? null,
  }
}

export async function shufGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (typeof parsed === 'string') {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(parsed) })]
  }
  const { count: nFlag, inputRange, echo: echoMode, zeroTerminated: zeroSep } = parsed
  const repeat = parsed.withReplacement
  const output =
    parsed.output === null
      ? null
      : new PathSpec({
          virtual: parsed.output,
          directory: parsed.output,
          resourcePath: mountKey(parsed.output, opts.mountPrefix ?? ''),
          resolved: true,
        })
  const sep = zeroSep ? '\x00' : '\n'

  let items: string[]
  if (inputRange !== null) {
    // `-i` takes two unsigned bounds with the low one no greater than the
    // high one. Every other shape is one message, so a negative low bound
    // (`-2-1`) and a decreasing range (`3-1`) are refused here rather than
    // read as a range; shuf has no decreasing-range diagnostic of its own.
    const bounds = parseInputRange(inputRange)
    if (bounds === null) {
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode(`shuf: invalid input range: '${quoteText(inputRange)}'\n`),
        }),
      ]
    }
    items = []
    for (let value = bounds[0]; value <= bounds[1]; value++) items.push(String(value))
  } else if (echoMode) {
    const base = paths.length > 0 ? paths.map((p) => p.mountPath) : [...texts]
    items = base
  } else if (paths.length > 0) {
    items = []
    for (const p of paths) {
      const data = DEC.decode(await materialize(stream(p)))
      if (zeroSep) for (const l of data.split('\x00')) items.push(l)
      else for (const l of splitLinesNoTrailing(data)) items.push(l)
    }
  } else {
    const stdinData = await readStdinAsync(opts.stdin)
    if (stdinData === null) {
      return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('shuf: missing operand\n') })]
    }
    const text = DEC.decode(stdinData)
    items = zeroSep ? text.split('\x00') : splitLinesNoTrailing(text)
  }
  const out = processItems(items, repeat, nFlag)
  // `shuf -n 0` is valid and prints zero bytes, so the separator
  // terminates each line rather than being appended to the join.
  const result: ByteSource = ENC.encode(out.length === 0 ? '' : out.join(sep) + sep)
  if (output !== null) {
    await write(output, result)
    return [null, new IOResult({ writes: { [output.mountPath]: result } })]
  }
  return [result, new IOResult()]
}
