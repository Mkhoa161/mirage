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
import { materialize } from '../../../io/types.ts'
import type { FlagValue } from '../../spec/types.ts'
import type { CommandOpts } from '../../config.ts'
import { parseFlags, parseInputRange, shufGeneric } from './shuf.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function stubStream(): AsyncIterable<Uint8Array> {
  throw new Error('shuf read an operand although its line count was refused')
}

function stubWrite(): Promise<void> {
  throw new Error('shuf wrote although its line count was refused')
}

async function* stdinOf(text: string): AsyncIterable<Uint8Array> {
  yield ENC.encode(text)
}

async function run(
  flags: Record<string, FlagValue>,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const opts = {
    stdin: stdinOf('x\n'),
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 'ram' } as never,
  } as CommandOpts
  // `CommandFnResult` is nullable — null is how a handler says it does not
  // apply — and shuf never answers that way, so say so rather than
  // destructure a union.
  const result = await shufGeneric([], [], opts, stubStream, stubWrite)
  if (result === null) throw new Error('shuf declined to handle its own operands')
  const [out, io] = result
  return {
    exit: io.exitCode,
    stdout: out === null ? '' : DEC.decode(await materialize(out)),
    stderr: io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : '',
  }
}

describe('shuf -n refuses a line count it cannot read whole', () => {
  // GNU coreutils 9.4: exit 1, a single stderr line, no `Try --help` line,
  // and the WHOLE argument quoted — `-n 2x` reports '2x', not 'x'. To shuf
  // a `-` is an invalid character rather than a sign, so `-1` is refused
  // while scanning and carries NO `: Numerical result out of range` clause
  // the way `nl -w -3` does.
  it.each([
    ['abc', "shuf: invalid line count: 'abc'\n"],
    ['2x', "shuf: invalid line count: '2x'\n"],
    ['-1', "shuf: invalid line count: '-1'\n"],
    ['', "shuf: invalid line count: ''\n"],
  ])('refuses -n %j before reading anything', async (value, message) => {
    const got = await run({ head_count: value })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  it('still shuffles with a valid line count', async () => {
    const got = await run({ head_count: '1' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('x\n')
    expect(got.stderr).toBe('')
  })

  // `+2` is a sign, and reads as 2 would.
  it('accepts a leading plus as a sign', async () => {
    const got = await run({ head_count: '+1' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('x\n')
    expect(got.stderr).toBe('')
  })

  // Only the sign is refused: zero is a valid count, and it prints zero
  // bytes rather than one bare separator.
  it('reads 0 as a valid count that prints nothing', async () => {
    const got = await run({ head_count: '0' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe('')
  })
})

describe('shuf -i answers every malformed range with one message', () => {
  // GNU is totally uniform here: non-numeric bounds, a decreasing range, a
  // negative low bound, a missing dash and an empty value all read the same,
  // with the WHOLE argument quoted and no `Try --help` line. shuf has no
  // decreasing-range diagnostic of its own, so cut's is not borrowed.
  it.each([['1-x'], ['x-3'], ['abc'], ['3-1'], ['-2-1'], ['1'], ['']])(
    'refuses -i %j',
    async (value) => {
      const got = await run({ input_range: value })
      expect(got.exit).toBe(1)
      expect(got.stdout).toBe('')
      expect(got.stderr).toBe(`shuf: invalid input range: '${value}'\n`)
    },
  )

  it('reads a single-element range', async () => {
    const got = await run({ input_range: '2-2' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('2\n')
    expect(got.stderr).toBe('')
  })

  it('emits every value of an ascending range, ignoring stdin', async () => {
    const got = await run({ input_range: '1-3' })
    expect(got.exit).toBe(0)
    expect(got.stdout.split('\n').slice(0, 3).sort()).toEqual(['1', '2', '3'])
    expect(got.stderr).toBe('')
  })
})

// A trailing newline in a value is refused on both hosts, and the python
// twin was the one that accepted it: its `$` also matches immediately BEFORE
// a trailing newline, so `re.match(r'^\+?[0-9]+$', '2\n')` SUCCEEDED and read
// `shuf -n $'2\n'` as the valid count 2 (ground truth NL2-A). The value is
// rendered through gnulib `quote()`, so the newline is the two characters
// `\n` and not the byte (NL3-A).
describe('shuf refuses a trailing newline in a value', () => {
  it.each([
    ['2\n', '2\\n'],
    ['1\n2', '1\\n2'],
    ['0\n', '0\\n'],
    ['2\r', '2\\r'],
    ['2\x01', '2\\001'],
  ] as [string, string][])('-n %j', async (value, quoted) => {
    const got = await run({ head_count: value })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(`shuf: invalid line count: '${quoted}'\n`)
  })

  it.each([
    ['1-3\n', '1-3\\n'],
    ['1-3\n5', '1-3\\n5'],
    ['2-2\n', '2-2\\n'],
  ] as [string, string][])('-i %j', async (value, quoted) => {
    const got = await run({ input_range: value })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(`shuf: invalid input range: '${quoted}'\n`)
  })

  // The control: the anchoring must not refuse a clean value.
  it.each(['2', '+2', '0'])('still accepts -n %s', (value) => {
    expect(typeof parseFlags({ head_count: value })).not.toBe('string')
  })
})

// LEADING C whitespace is SKIPPED, because that is `strtoumax`'s own skip,
// while trailing whitespace is garbage. `\s` would be wrong for the same
// reason as in nl: it also matches every Unicode space, which GNU refuses.
// Ground truth NL3-C.
describe('shuf skips leading C whitespace on -n', () => {
  it.each([' 2', '\t2', '\n2', '\x0b2', '\f2', '\r2', '  2', ' +2'])('accepts %j', (value) => {
    expect(typeof parseFlags({ head_count: value })).not.toBe('string')
  })

  // `-n` is unsigned, so ' -2' is refused where nl's `-v` accepts it.
  it.each([
    ['2 ', '2 '],
    [' -2', ' -2'],
    ['+ 2', '+ 2'],
    ['\x1c2', '\\0342'],
  ] as [string, string][])('refuses %j', (value, quoted) => {
    expect(parseFlags({ head_count: value })).toBe(`shuf: invalid line count: '${quoted}'\n`)
  })
})

// `-i` splits at the FIRST dash and scans each bound on its own, so a `+` and
// a leading blank ride on either bound independently. Every row measured
// against GNU (ground truth NL3-D).
describe('shuf -i takes a prefix on either bound', () => {
  it.each([
    ['1-3', [1, 3]],
    ['+1-3', [1, 3]],
    ['1-+3', [1, 3]],
    ['+1-+3', [1, 3]],
    [' +1-3', [1, 3]],
    ['1- 3', [1, 3]],
    ['+0-0', [0, 0]],
    ['10-20', [10, 20]],
    ['2-2', [2, 2]],
    ['01-03', [1, 3]],
  ] as [string, [number, number]][])('accepts %j', (raw, bounds) => {
    expect(parseInputRange(raw)).toEqual(bounds)
  })

  // A `-` is never a sign, and shuf has one message for all of it.
  it.each([
    '-1-3',
    '1--3',
    '++1-3',
    '1-2-3',
    '1-3-',
    ' 1 - 3 ',
    '1 -3',
    '-',
    '1-',
    '-3',
    '3-1',
    '1-3\n',
    'abc',
    '1',
    '',
  ])('refuses %j', (raw) => {
    expect(parseInputRange(raw)).toBe(null)
  })
})

// shuf reads its flags once into a frozen struct through a module-level
// parseFlags on a spec-bound FlagView, the shape CLAUDE.md requires of every
// generic and the shape the python twin already had; the body reads struct
// fields rather than querying the bag inline.
describe('shuf parseFlags is the one flag read', () => {
  it('returns the struct for a line GNU accepts', () => {
    const parsed = parseFlags({
      head_count: '+2',
      echo: true,
      zero_terminated: true,
      repeat: true,
      input_range: '1-3',
      output: '/data/out.txt',
    })
    expect(parsed).toEqual({
      count: 2,
      echo: true,
      zeroTerminated: true,
      withReplacement: true,
      inputRange: '1-3',
      output: '/data/out.txt',
    })
  })

  it('returns the stderr text for a line GNU refuses', () => {
    expect(parseFlags({ head_count: '-1' })).toBe("shuf: invalid line count: '-1'\n")
  })

  it('defaults every field when the line carried no flag', () => {
    expect(parseFlags({})).toEqual({
      count: null,
      echo: false,
      zeroTerminated: false,
      withReplacement: false,
      inputRange: null,
      output: null,
    })
  })
})
