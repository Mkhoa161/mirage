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

import { fsStrerror } from '../../utils/errors.ts'
import { AsyncLineIterator } from '../../io/async_line_iterator.ts'
import { type IOResult } from '../../io/types.ts'
import { type FileStat, FileType } from '../../types.ts'
import { getExtension } from '../resolve.ts'
import { BINARY_EXTENSIONS } from './constants.ts'
import { grepContextLines } from './grep_context.ts'
import { compilePattern } from './grep_pattern.ts'
import { NO_FILTERS, type WalkFilters, dirAdmitted, fileAdmitted } from './grep_select.ts'
import type { AsyncReadBytesFn, AsyncReaddirFn, AsyncStatFn } from './utils/types.ts'

const DEC = new TextDecoder()

export interface GrepLinesOptions {
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  filesOnly: boolean
  onlyMatching: boolean
  maxCount: number | null
}

export function grepLines(
  path: string,
  data: readonly string[],
  compiled: RegExp,
  opts: GrepLinesOptions,
): string[] {
  const results: string[] = []
  let count = 0
  const reGlobal = opts.onlyMatching
    ? new RegExp(
        compiled.source,
        compiled.flags.includes('g') ? compiled.flags : compiled.flags + 'g',
      )
    : null
  for (let i = 0; i < data.length; i++) {
    const line = data[i] ?? ''
    const found = compiled.test(line)
    const matched = opts.invert ? !found : found
    if (!matched) continue
    count += 1
    if (!opts.countOnly && !opts.filesOnly) {
      if (opts.onlyMatching && !opts.invert && reGlobal !== null) {
        // GNU -o prints every match on the line, one per line, and prints
        // nothing at all for an empty match; the line still counts as
        // selected, which is what -c and the exit status read.
        reGlobal.lastIndex = 0
        for (;;) {
          const m = reGlobal.exec(line)
          if (m === null) break
          // A global regex that matched the empty string leaves lastIndex
          // where it was, so exec would keep returning it.
          if (m[0] === '') {
            reGlobal.lastIndex += 1
            continue
          }
          results.push(opts.lineNumbers ? `${String(i + 1)}:${m[0]}` : m[0])
        }
      } else {
        results.push(opts.lineNumbers ? `${String(i + 1)}:${line}` : line)
      }
    }
    if (opts.maxCount !== null && count >= opts.maxCount) break
  }
  if (opts.countOnly) return [String(count)]
  if (opts.filesOnly) return count > 0 ? [path] : []
  return results
}

// Whether any `path:count` record has a nonzero count.
export function countRecordsHaveMatches(results: readonly string[]): boolean {
  return results.some((r) => Number.parseInt(r.slice(r.lastIndexOf(':') + 1), 10) > 0)
}

// Drop zero-count chunks for the `rg -c` fallback stream. Unlike grep -c
// (which prints "0" and exits 1), ripgrep omits files with no matches.
// Mirrors Python's nonzero_count_stream.
export async function* nonzeroCountStream(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    if (Number.parseInt(DEC.decode(chunk).trim() || '0', 10) > 0) yield chunk
  }
}

// Yield count-only grep output, setting exit 1 when all counts are zero.
// GNU grep -c prints the count but still exits 1 when no lines were
// selected, so emptiness-based exit detection cannot apply.
export async function* countExitStream(
  source: AsyncIterable<Uint8Array>,
  io: IOResult,
): AsyncIterable<Uint8Array> {
  let anyMatch = false
  for await (const chunk of source) {
    if (Number.parseInt(DEC.decode(chunk).trim() || '0', 10) > 0) anyMatch = true
    yield chunk
  }
  if (!anyMatch) io.exitCode = 1
}

export interface GrepStreamOptions {
  invert: boolean
  lineNumbers: boolean
  onlyMatching: boolean
  maxCount: number | null
  countOnly: boolean
  afterContext: number
  beforeContext: number
  // The exit status follows the selected LINES, not the printed bytes: under
  // -o a line whose only match is empty prints nothing and still exits 0, so
  // a caller cannot derive the status from an empty stream. Given an
  // IOResult, the generator reports selection on it the way grepInput does
  // (1 to start, 0 as soon as a line is selected); left out, the caller
  // keeps whatever it decides for itself.
  io?: IOResult
}

export async function* grepStream(
  source: AsyncIterable<Uint8Array>,
  pat: RegExp,
  opts: GrepStreamOptions,
): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder()
  const dec = new TextDecoder('utf-8', { fatal: false })
  const hasContext = opts.afterContext > 0 || opts.beforeContext > 0
  if (hasContext && !opts.countOnly && !opts.onlyMatching) {
    const allLines: string[] = []
    const iter = new AsyncLineIterator(source)
    for await (const raw of iter) allLines.push(dec.decode(raw))
    let printed = false
    for (const chunk of grepContextLines(
      allLines,
      pat,
      opts.invert,
      opts.lineNumbers,
      opts.maxCount,
      opts.afterContext,
      opts.beforeContext,
    )) {
      printed = true
      yield chunk
    }
    // Context lines only ever accompany a selected line, so here emptiness
    // and selection are the same fact.
    if (opts.io !== undefined) opts.io.exitCode = printed ? 0 : 1
    return
  }
  if (opts.io !== undefined) opts.io.exitCode = 1
  let matchCount = 0
  let lineNum = 0
  const reGlobal = opts.onlyMatching
    ? new RegExp(pat.source, pat.flags.includes('g') ? pat.flags : pat.flags + 'g')
    : null
  const iter = new AsyncLineIterator(source)
  for await (const rawLine of iter) {
    lineNum += 1
    const line = dec.decode(rawLine)
    const found = pat.test(line)
    const hit = opts.invert ? !found : found
    if (!hit) continue
    if (opts.io !== undefined) opts.io.exitCode = 0
    if (opts.onlyMatching && !opts.invert && reGlobal !== null) {
      // GNU -o prints every match on the line, one per line, and prints
      // nothing at all for an empty match; the line is still selected, so
      // it counts once here whatever its matches looked like (-c and -m
      // both count selected lines, as they do without -o).
      reGlobal.lastIndex = 0
      matchCount += 1
      for (;;) {
        const m = reGlobal.exec(line)
        if (m === null) break
        // A global regex that matched the empty string leaves lastIndex
        // where it was, so exec would keep returning it and this generator
        // would never finish.
        if (m[0] === '') {
          reGlobal.lastIndex += 1
          continue
        }
        if (!opts.countOnly) yield enc.encode(m[0] + '\n')
      }
      if (opts.maxCount !== null && matchCount >= opts.maxCount) {
        if (opts.countOnly) yield enc.encode(String(matchCount) + '\n')
        return
      }
    } else {
      matchCount += 1
      if (!opts.countOnly) {
        if (opts.lineNumbers) yield enc.encode(`${String(lineNum)}:${line}\n`)
        else {
          const out = new Uint8Array(rawLine.byteLength + 1)
          out.set(rawLine, 0)
          out[rawLine.byteLength] = 0x0a
          yield out
        }
      }
      if (opts.maxCount !== null && matchCount >= opts.maxCount) {
        if (opts.countOnly) yield enc.encode(String(matchCount) + '\n')
        return
      }
    }
  }
  if (opts.countOnly) yield enc.encode(String(matchCount) + '\n')
}

export interface GrepFilesOnlyOptions {
  recursive: boolean
  ignoreCase: boolean
  invert: boolean
  lineNumbers: boolean
  countOnly: boolean
  fixedString: boolean
  onlyMatching: boolean
  maxCount: number | null
  wholeWord: boolean
  basic: boolean
  filters?: WalkFilters
}

export async function grepRecursive(
  readdirFn: AsyncReaddirFn,
  statFn: AsyncStatFn,
  readBytesFn: AsyncReadBytesFn,
  path: string,
  compiled: RegExp,
  opts: GrepFilesOnlyOptions,
  warnings: string[] | null,
  filesOnly = true,
): Promise<string[]> {
  const lineOpts: GrepLinesOptions = {
    invert: opts.invert,
    lineNumbers: opts.lineNumbers,
    countOnly: opts.countOnly,
    filesOnly,
    onlyMatching: opts.onlyMatching,
    maxCount: opts.maxCount,
  }
  const results: string[] = []
  let entries: string[]
  try {
    entries = await readdirFn(path)
  } catch (err) {
    if (warnings !== null)
      warnings.push(
        `grep: ${path}: ${fsStrerror(err) ?? (err instanceof Error ? err.message : String(err))}`,
      )
    return results
  }
  for (const entry of entries) {
    let s: FileStat
    try {
      s = await statFn(entry)
    } catch (err) {
      if (warnings !== null)
        warnings.push(
          `grep: ${entry}: ${fsStrerror(err) ?? (err instanceof Error ? err.message : String(err))}`,
        )
      continue
    }
    const filters = opts.filters ?? NO_FILTERS
    if (s.type === FileType.DIRECTORY) {
      if (!dirAdmitted(entry, filters)) continue
      const sub = await grepRecursive(
        readdirFn,
        statFn,
        readBytesFn,
        entry,
        compiled,
        opts,
        warnings,
        filesOnly,
      )
      for (const r of sub) results.push(r)
      continue
    }
    if (s.type === FileType.CHAR_DEVICE) continue
    if (!fileAdmitted(entry, filters)) continue
    if (!filters.text && BINARY_EXTENSIONS.has(getExtension(entry) ?? '')) continue
    try {
      const lines = new TextDecoder('utf-8', { fatal: false })
        .decode(await readBytesFn(entry))
        .split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const fileResults = grepLines(entry, lines, compiled, lineOpts)
      if (opts.countOnly) {
        if (fileResults.length > 0) results.push(`${entry}:${fileResults[0] ?? ''}`)
      } else if (filesOnly) {
        for (const r of fileResults) results.push(r)
      } else {
        for (const r of fileResults) results.push(`${entry}:${r}`)
      }
    } catch (err) {
      if (warnings !== null)
        warnings.push(
          `grep: ${entry}: ${fsStrerror(err) ?? (err instanceof Error ? err.message : String(err))}`,
        )
    }
  }
  return results
}

// The exit status grep and ripgrep share. An operand the search could not read
// is exit 2, and it outranks a match: both tools print the lines they did find
// and still exit 2. The one exception is grep's -q, documented as exiting zero
// when a match is found "even if an error was detected". Everything else is the
// familiar 0 for a match, 1 for none.
export function exitCodeFor(matched: boolean, failed: boolean, quiet: boolean): number {
  if (matched && quiet) return 0
  if (failed) return 2
  return matched ? 0 : 1
}

// Whether an operand names a directory, asked on both channels. Both are
// consulted because on a prefix store a directory is the set of keys under it
// rather than an object, so stat misses one that readdir lists happily. The
// listing has to be non-empty to count: such a store answers readdir for any
// path at all, returning nothing for one that does not exist, so a bare "it did
// not throw" reads every missing file as a directory. The cost is that a
// genuinely empty directory is invisible there, which is the same thing `du`
// already documents and the safer way round: naming a missing file is a report
// a caller can act on, calling it a directory is not.
async function operandIsDirectory(
  readdirFn: AsyncReaddirFn,
  info: FileStat | null,
  path: string,
): Promise<boolean> {
  if (info !== null) return info.type === FileType.DIRECTORY
  try {
    return (await readdirFn(path)).length > 0
  } catch {
    return false
  }
}

// GNU's stderr line for an operand grep could not read. A directory does not
// reach here: it is recognized from its type before the read, because what a
// read throws for one is whatever the backend happens to do about it.
function operandError(path: string, err: unknown): string {
  return `grep: ${path}: ${fsStrerror(err) ?? (err instanceof Error ? err.message : String(err))}`
}

export async function grepFilesOnly(
  readdirFn: AsyncReaddirFn,
  statFn: AsyncStatFn,
  readBytesFn: AsyncReadBytesFn,
  path: string,
  pattern: string,
  opts: GrepFilesOnlyOptions,
  warnings: string[] | null = null,
): Promise<string[]> {
  const compiled = compilePattern(
    pattern,
    opts.ignoreCase,
    opts.fixedString,
    opts.wholeWord,
    opts.basic,
  )
  // What the operand is, asked before it is read. A failed read is a
  // backend-dependent proxy for the type and a poor one: a keyed store reads a
  // directory path without complaint and returns nothing, and ssh answers with
  // an SFTP error that is not a filesystem error at all, so classifying
  // afterwards gets a different answer per backend.
  let info: FileStat | null = null
  try {
    info = await statFn(path)
  } catch {
    info = null
  }
  if (opts.recursive) {
    // GNU only walks directory operands; a file operand under -r takes the
    // plain single-file scan (python grep_files_only parity). Stat failures
    // keep the walk so missing operands surface its error shape.
    const operandIsFile = info !== null && info.type !== FileType.DIRECTORY
    if (!operandIsFile) {
      return grepRecursive(readdirFn, statFn, readBytesFn, path, compiled, opts, warnings)
    }
  }
  // GNU names a directory operand and moves on without descending into it; only
  // -r walks one, and that branch returned above. Walking here would make -l
  // alone behave like -rl.
  if (await operandIsDirectory(readdirFn, info, path)) {
    if (warnings !== null) warnings.push(`grep: ${path}: Is a directory`)
    return []
  }
  if (!fileAdmitted(path, opts.filters ?? NO_FILTERS)) return []
  let data: Uint8Array
  try {
    data = await readBytesFn(path)
  } catch (err) {
    if (warnings !== null) warnings.push(operandError(path, err))
    return []
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data)
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let count = 0
  for (const line of lines) {
    const found = compiled.test(line)
    const matched = opts.invert ? !found : found
    if (matched) {
      count += 1
      if (opts.maxCount !== null && count >= opts.maxCount) break
    }
  }
  if (opts.countOnly) return [String(count)]
  return count > 0 ? [path] : []
}

// Prefix every line chunk with a filename label (grep -H). The grep stream
// yields one line per chunk, so a per-chunk prefix is a per-line prefix.
export async function* prefixLines(
  source: AsyncIterable<Uint8Array>,
  prefix: string,
): AsyncIterable<Uint8Array> {
  const encoded = new TextEncoder().encode(prefix)
  for await (const chunk of source) {
    const out = new Uint8Array(encoded.byteLength + chunk.byteLength)
    out.set(encoded, 0)
    out.set(chunk, encoded.byteLength)
    yield out
  }
}
