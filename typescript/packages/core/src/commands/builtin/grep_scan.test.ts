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

import { describe, expect, it } from 'vitest'
import { IOResult } from '../../io/types.ts'
import { ContentType, FileStat, FileType } from '../../types.ts'
import {
  grepFilesOnly,
  grepLines,
  grepStream,
  type GrepLinesOptions,
  type GrepStreamOptions,
} from './grep_scan.ts'

const ENC = new TextEncoder()

describe('grepFilesOnly', () => {
  it('scans file operands under recursive instead of walking them', async () => {
    // GNU: `grep -rl pat file` treats the operand as a file; only directory
    // operands are walked (search-narrowed candidates arrive as files).
    const readdirFn = (path: string): Promise<string[]> => Promise.reject(new Error(path))
    const statFn = (path: string): Promise<FileStat> =>
      Promise.resolve(new FileStat({ name: path, type: FileType.FILE, content: ContentType.TEXT }))
    const readBytesFn = (): Promise<Uint8Array> => Promise.resolve(ENC.encode('alpha beta\n'))
    const hits = await grepFilesOnly(readdirFn, statFn, readBytesFn, '/data/notes.txt', 'alpha', {
      recursive: true,
      ignoreCase: false,
      invert: false,
      lineNumbers: false,
      countOnly: false,
      fixedString: false,
      onlyMatching: false,
      maxCount: null,
      wholeWord: false,
      basic: true,
    })
    expect(hits).toEqual(['/data/notes.txt'])
  })
})

const DEC = new TextDecoder()

async function* bytesOf(text: string): AsyncIterable<Uint8Array> {
  yield ENC.encode(text)
}

// Bounded drive of the generator: a pattern that can match the empty string
// used to leave reGlobal.lastIndex where it was, so grepStream yielded
// forever. Neither the integ nor the conformance schema has a per-case
// timeout, so a regression there would burn the whole job; stopping after
// `limit` yields turns it into an assertion instead.
async function take(
  source: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ text: string; capped: boolean }> {
  const parts: string[] = []
  let capped = false
  for await (const chunk of source) {
    if (parts.length >= limit) {
      capped = true
      break
    }
    parts.push(DEC.decode(chunk))
  }
  return { text: parts.join(''), capped }
}

function streamOpts(overrides: Partial<GrepStreamOptions> = {}): GrepStreamOptions {
  return {
    invert: false,
    lineNumbers: false,
    onlyMatching: true,
    maxCount: null,
    countOnly: false,
    afterContext: 0,
    beforeContext: 0,
    ...overrides,
  }
}

function lineOpts(overrides: Partial<GrepLinesOptions> = {}): GrepLinesOptions {
  return {
    invert: false,
    lineNumbers: false,
    countOnly: false,
    filesOnly: false,
    onlyMatching: true,
    maxCount: null,
    ...overrides,
  }
}

describe('grepStream -o terminates on an empty-matching pattern', () => {
  it.each([
    ['[0-9]*', 'ab\n'],
    ['', 'ab\n'],
    ['^', 'ab\n'],
    ['$', 'ab\n'],
    ['[0-9]*', 'a\nb\n'],
  ])('finishes for /%s/ over %j', async (source, input) => {
    const got = await take(grepStream(bytesOf(input), new RegExp(source), streamOpts()), 64)
    expect(got.capped).toBe(false)
    expect(got.text).toBe('')
  })
})

describe('grepStream -o GNU semantics', () => {
  // GNU grep 3.11: `printf 'ab\n' | grep -o '[0-9]*'` writes 0 bytes and
  // exits 0, while `grep -oc '[0-9]*'` says 1 — an empty match prints
  // nothing but the line is still selected.
  it('prints nothing for an empty match yet counts the line', async () => {
    const printed = await take(grepStream(bytesOf('ab\n'), /[0-9]*/, streamOpts()), 64)
    expect(printed.text).toBe('')
    const counted = await take(
      grepStream(bytesOf('ab\n'), /[0-9]*/, streamOpts({ countOnly: true })),
      64,
    )
    expect(counted.text).toBe('1\n')
  })

  it('counts selected lines, not matches, under -c', async () => {
    const counted = await take(
      grepStream(bytesOf('a1b2c\n'), /[0-9]/, streamOpts({ countOnly: true })),
      64,
    )
    expect(counted.text).toBe('1\n')
  })

  it.each([
    ['a1b\n', '[0-9]*', '1\n'],
    ['a1b2c\n', '[0-9]', '1\n2\n'],
    ['1a22b\n', '[0-9]*', '1\n22\n'],
    ['abc\n', 'b*', 'b\n'],
  ])('prints every non-empty match of /%s/ in %j', async (input, source, expected) => {
    const got = await take(grepStream(bytesOf(input), new RegExp(source), streamOpts()), 64)
    expect(got.capped).toBe(false)
    expect(got.text).toBe(expected)
  })
})

describe('grepLines -o GNU semantics', () => {
  it('prints nothing for an empty match yet counts the line', () => {
    expect(grepLines('/p', ['ab'], /[0-9]*/, lineOpts())).toEqual([])
    expect(grepLines('/p', ['ab'], /[0-9]*/, lineOpts({ countOnly: true }))).toEqual(['1'])
    expect(grepLines('/p', ['ab'], /[0-9]*/, lineOpts({ filesOnly: true }))).toEqual(['/p'])
  })

  it('prints every non-empty match on the line, one per entry', () => {
    expect(grepLines('/p', ['a1b'], /[0-9]*/, lineOpts())).toEqual(['1'])
    expect(grepLines('/p', ['a1b2c'], /[0-9]/, lineOpts())).toEqual(['1', '2'])
    expect(grepLines('/p', ['1a22b'], /[0-9]*/, lineOpts())).toEqual(['1', '22'])
    expect(grepLines('/p', ['abc'], /b*/, lineOpts())).toEqual(['b'])
  })

  it('numbers every match of the line it came from', () => {
    expect(grepLines('/p', ['x', 'a1b2c'], /[0-9]/, lineOpts({ lineNumbers: true }))).toEqual([
      '2:1',
      '2:2',
    ])
  })
})

describe('grepStream reports selection on the IOResult it is given', () => {
  // The other half of GNU's -o rule: a line whose only match was empty
  // prints nothing, so the caller cannot read the exit status off an empty
  // stream. `printf 'ab\n' | grep -o '[0-9]*'` writes 0 bytes and exits 0.
  it('exits 0 for a line selected by an empty match', async () => {
    const io = new IOResult()
    const got = await take(grepStream(bytesOf('ab\n'), /[0-9]*/, streamOpts({ io })), 64)
    expect(got.text).toBe('')
    expect(io.exitCode).toBe(0)
  })

  it('exits 1 when no line was selected at all', async () => {
    const io = new IOResult()
    const got = await take(grepStream(bytesOf('ab\n'), /[0-9]/, streamOpts({ io })), 64)
    expect(got.text).toBe('')
    expect(io.exitCode).toBe(1)
  })
})
