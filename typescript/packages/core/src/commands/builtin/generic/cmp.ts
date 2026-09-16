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
import { FlagView } from '../../spec/flag_view.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { formatFsError, isFsError } from '../../../utils/errors.ts'
import { CMP_SIZE_UNITS, INTMAX, XSTRTOUMAX_PATTERN } from '../constants.ts'
import { formatRecords } from '../utils/output.ts'
import { parseBase0 } from '../utils/size_suffix.ts'
import { extraOperandError, usageHint } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'
import { UsageError } from '../../errors.ts'

const ENC = new TextEncoder()

const TRY_HELP = `\n${usageHint(CommandName.CMP)}`
const NEWLINE = 0x0a

function octal(n: number, width = 0): string {
  return n.toString(8).padStart(width)
}

/**
 * One GNU `cmp` byte count read the way xstrtoumax reads it.
 *
 * Base 0, so `010` is 8 and `0x400` is 1024; one leading `+` and
 * leading whitespace are allowed; the remainder is a size suffix from
 * cmp's own letter set. Every rejection -- unparsable digits, unknown
 * suffix, or a product past INTMAX -- is the same usage error naming
 * the long option, not a crash and not od's "too large".
 *
 * `shown` overrides the spelling named in the diagnostic: GNU prints
 * the operand from the position it was reading, so a bad `SKIP1` names
 * the whole `SKIP1:SKIP2` pair while a bad `SKIP2` names only itself.
 *
 * The accept/reject boundary is computed in BigInt and so is exact, but
 * the returned count is a double like od's: above 2**53 it is the
 * nearest representable value, not python's exact integer. The count is
 * only ever a slice bound, and no file reaches an exabyte, so the two
 * runtimes still compare the same bytes.
 */
export function parseCount(raw: string, option: string, shown?: string): number {
  const error = new UsageError(`cmp: invalid ${option} value '${shown ?? raw}'${TRY_HELP}`)
  const match = XSTRTOUMAX_PATTERN.exec(raw)
  const suffix = match?.[2] ?? ''
  const unit = suffix === '' ? 1 : CMP_SIZE_UNITS[suffix]
  if (match === null || unit === undefined) throw error
  const count = parseBase0(match[1] ?? '') * BigInt(unit)
  if (count > INTMAX) throw error
  return Number(count)
}

/**
 * The `-i` operand as one skip per file.
 *
 * GNU takes `SKIP` for both files or `SKIP1:SKIP2` for one each, so
 * `-i 0:3` compares all of the first file against the fourth byte
 * onward of the second. A colon is the only place the first count may
 * stop, which is why `1b:1` is rejected naming the whole pair while
 * `1:1b` is rejected naming just `1b`.
 */
export function parseSkip(raw: string): [number, number] {
  const cut = raw.indexOf(':')
  if (cut === -1) {
    const both = parseCount(raw, '--ignore-initial')
    return [both, both]
  }
  return [
    parseCount(raw.slice(0, cut), '--ignore-initial', raw),
    parseCount(raw.slice(cut + 1), '--ignore-initial'),
  ]
}

/**
 * One byte rendered the way GNU `cmp -b` renders it.
 *
 * The cat -v alphabet: a control byte becomes `^X` (so tab is `^I`,
 * unlike `cat -v` itself), DEL becomes `^?`, and a high byte becomes
 * `M-` followed by the same rules on its low seven bits.
 */
export function visible(byte: number): string {
  if (byte >= 128) return `M-${visible(byte - 128)}`
  if (byte === 127) return '^?'
  if (byte < 32) return `^${String.fromCharCode(byte + 64)}`
  return String.fromCharCode(byte)
}

interface CmpFlags {
  readonly silent: boolean
  readonly verbose: boolean
  readonly limit: number | null
  readonly printBytes: boolean
  readonly skip: readonly [number, number]
}

function parseFlags(fl: FlagView): CmpFlags {
  const nRaw = fl.asStr('n')
  const iRaw = fl.asStr('i')
  return {
    silent: fl.asBool('s'),
    verbose: fl.asBool('args_l'),
    limit: nRaw === undefined ? null : parseCount(nRaw, '--bytes'),
    printBytes: fl.asBool('b'),
    skip: iRaw === undefined ? [0, 0] : parseSkip(iRaw),
  }
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * GNU's `EOF on FILE` diagnostic for a common-prefix difference.
 *
 * It is a diagnostic, not output: GNU writes it to stderr and still
 * exits 1. `-l` reports the byte only, every other mode adds the line
 * the count lands in.
 */
function eofError(
  paths: PathSpec[],
  data1: Uint8Array,
  data2: Uint8Array,
  verbose: boolean,
): Uint8Array {
  const firstShorter = data1.byteLength < data2.byteLength
  const shorter = firstShorter ? paths[0] : paths[1]
  const held = firstShorter ? data1 : data2
  let msg = `cmp: EOF on ${shorter?.virtual ?? ''} after byte ${String(held.byteLength)}`
  if (!verbose) {
    let lines = 1
    for (const byte of held) if (byte === NEWLINE) lines += 1
    msg += `, in line ${String(lines)}`
  }
  return ENC.encode(`${msg}\n`)
}

export async function cmpGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<[ByteSource | null, IOResult]> {
  const parsed = parseFlags(new FlagView(opts.flags, specOf('cmp')))
  if (paths.length > 2) throw extraOperandError(CommandName.CMP, paths[2]?.rawPath ?? '')
  if (paths.length < 2) {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode('cmp: requires two paths\n') })]
  }
  const p0 = paths[0]
  const p1 = paths[1]
  if (p0 === undefined || p1 === undefined) return [null, new IOResult()]
  let data1: Uint8Array
  let data2: Uint8Array
  try {
    data1 = await materialize(stream(p0))
    data2 = await materialize(stream(p1))
  } catch (err) {
    if (!isFsError(err)) throw err
    // GNU cmp reserves exit 1 for "files differ"; trouble (a missing or
    // unreadable operand) is exit 2.
    return [null, new IOResult({ exitCode: 2, stderr: formatFsError('cmp', err, paths) })]
  }
  data1 = data1.slice(parsed.skip[0])
  data2 = data2.slice(parsed.skip[1])
  if (parsed.limit !== null) {
    data1 = data1.slice(0, parsed.limit)
    data2 = data2.slice(0, parsed.limit)
  }
  if (arraysEqual(data1, data2)) return [null, new IOResult()]
  if (parsed.silent) return [null, new IOResult({ exitCode: 1 })]
  const common = Math.min(data1.byteLength, data2.byteLength)
  if (parsed.verbose) {
    const outLines: string[] = []
    for (let idx = 0; idx < common; idx++) {
      const a = data1[idx] ?? 0
      const b = data2[idx] ?? 0
      if (a === b) continue
      let row = `${String(idx + 1)} ${octal(a, 3)}`
      if (parsed.printBytes) row += ` ${visible(a).padEnd(4)}`
      row += ` ${octal(b, 3)}`
      if (parsed.printBytes) row += ` ${visible(b)}`
      outLines.push(row)
    }
    const io =
      data1.byteLength === data2.byteLength
        ? new IOResult({ exitCode: 1 })
        : new IOResult({ exitCode: 1, stderr: eofError(paths, data1, data2, true) })
    return [formatRecords(outLines), io]
  }
  for (let idx = 0; idx < common; idx++) {
    const a = data1[idx] ?? 0
    const b = data2[idx] ?? 0
    if (a === b) continue
    let line = 1
    for (let k = 0; k < idx; k++) if (data1[k] === NEWLINE) line += 1
    // GNU counts in `byte` under -b and in `char` otherwise, on the
    // same offset -- the word tracks the flag, not a unit.
    const unit = parsed.printBytes ? 'byte' : 'char'
    let msg = `${p0.virtual} ${p1.virtual} differ: ${unit} ${String(idx + 1)}, line ${String(line)}`
    if (parsed.printBytes) {
      msg += ` is ${octal(a, 3)} ${visible(a)} ${octal(b, 3)} ${visible(b)}`
    }
    return [formatRecords([msg]), new IOResult({ exitCode: 1 })]
  }
  return [
    null,
    new IOResult({ exitCode: 1, stderr: eofError(paths, data1, data2, parsed.verbose) }),
  ]
}
