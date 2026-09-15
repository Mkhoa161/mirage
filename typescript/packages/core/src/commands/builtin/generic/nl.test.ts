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
import { nlGeneric } from './nl.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function stubStream(): AsyncIterable<Uint8Array> {
  throw new Error('nl read an operand although a numeric option was refused')
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
  // apply — and nl never answers that way, so say so rather than destructure
  // a union.
  const result = await nlGeneric([], opts, stubStream)
  if (result === null) throw new Error('nl declined to handle its own operands')
  const [out, io] = result
  return {
    exit: io.exitCode,
    stdout: out === null ? '' : DEC.decode(await materialize(out)),
    stderr: io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : '',
  }
}

describe('nl refuses a numeric option it cannot read whole', () => {
  // GNU coreutils 9.4: exit 1, a single stderr line, no `Try --help` line,
  // and — unlike expand and cut — the WHOLE argument quoted, so `-w 2x`
  // reports '2x' rather than 'x'. Each of the four options has its own
  // wording.
  it.each([
    ['starting_line_number', 'abc', "nl: invalid starting line number: 'abc'\n"],
    ['starting_line_number', '2x', "nl: invalid starting line number: '2x'\n"],
    ['line_increment', 'abc', "nl: invalid line number increment: 'abc'\n"],
    ['number_width', 'abc', "nl: invalid line number field width: 'abc'\n"],
    ['number_width', '2x', "nl: invalid line number field width: '2x'\n"],
    ['join_blank_lines', 'abc', "nl: invalid line number of blank lines: 'abc'\n"],
  ])('refuses %s=%s before numbering anything', async (dest, value, message) => {
    const got = await run({ [dest]: value })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  // GNU `printf 'x\n' | nl -v 5` prints 5 spaces, '5', a TAB and 'x'.
  it('still numbers with a valid starting line number', async () => {
    const got = await run({ starting_line_number: '5' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('     5\tx\n')
    expect(got.stderr).toBe('')
  })

  // A leading `+` is a sign on every one of the four, and reads as the
  // unsigned value would.
  it.each([
    ['starting_line_number', '+5', '     5\tx\n'],
    ['number_width', '+3', '  1\tx\n'],
    ['line_increment', '+2', '     1\tx\n'],
    ['join_blank_lines', '+2', '     1\tx\n'],
  ])('accepts %s=%s as a sign', async (dest, value, stdout) => {
    const got = await run({ [dest]: value })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe(stdout)
    expect(got.stderr).toBe('')
  })
})

// nl's four numeric options split two ways, and the split is observable in
// both the exit status and the shape of the message.
describe('nl -v and -i are signed', () => {
  // GNU numbers from a negative start and counts UP, and `-i -2` genuinely
  // decrements, so neither a negative nor a zero is an error.
  it('numbers from a negative start', async () => {
    const got = await run({ starting_line_number: '-5' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('    -5\tx\n')
    expect(got.stderr).toBe('')
  })

  it('accepts a zero increment', async () => {
    const got = await run({ line_increment: '0' })
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('     1\tx\n')
    expect(got.stderr).toBe('')
  })
})

describe('nl -w and -l require at least 1', () => {
  // A value that PARSED but fell out of range carries a THIRD colon-clause,
  // gnulib's strerror(ERANGE). Still exit 1 and still no `Try --help` line.
  it.each([
    [
      'number_width',
      '-3',
      "nl: invalid line number field width: '-3': Numerical result out of range\n",
    ],
    [
      'number_width',
      '0',
      "nl: invalid line number field width: '0': Numerical result out of range\n",
    ],
    [
      'join_blank_lines',
      '-2',
      "nl: invalid line number of blank lines: '-2': Numerical result out of range\n",
    ],
    [
      'join_blank_lines',
      '0',
      "nl: invalid line number of blank lines: '0': Numerical result out of range\n",
    ],
  ])('refuses %s=%s as out of range', async (dest, value, message) => {
    const got = await run({ [dest]: value })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  // The clause attaches to a RANGE failure, never to a scan failure, so
  // within one option the message shape depends on why the value failed.
  // It must not be appended unconditionally.
  it.each([
    ['number_width', "nl: invalid line number field width: ''\n"],
    ['join_blank_lines', "nl: invalid line number of blank lines: ''\n"],
  ])('refuses an empty %s without the range clause', async (dest, message) => {
    const got = await run({ [dest]: '' })
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })
})
