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
import { shufGeneric } from './shuf.ts'

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
