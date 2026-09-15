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
import { expandGeneric } from './expand.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function stubStream(): AsyncIterable<Uint8Array> {
  throw new Error('expand read an operand although its tab size was refused')
}

async function* stdinOf(text: string): AsyncIterable<Uint8Array> {
  yield ENC.encode(text)
}

async function run(
  flags: Record<string, FlagValue>,
  stdin: AsyncIterable<Uint8Array> | null = null,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const opts = {
    stdin,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: { kind: 'ram' } as never,
  } as CommandOpts
  // `CommandFnResult` is nullable — null is how a handler says it does not
  // apply — and expand never answers that way, so say so rather than
  // destructure a union.
  const result = await expandGeneric([], opts, stubStream)
  if (result === null) throw new Error('expand declined to handle its own operands')
  const [out, io] = result
  return {
    exit: io.exitCode,
    stdout: out === null ? '' : DEC.decode(await materialize(out)),
    stderr: io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : '',
  }
}

describe('expand --tabs refuses a value it cannot read whole', () => {
  // GNU coreutils 9.4: exit 1, a single stderr line and no `Try --help`
  // line, and the quote starts at the first character the scan could not
  // read — '8x' reports 'x' because the 8 parsed, '-4' reports the whole
  // argument because `-` is not a sign to expand and stops it at position 0.
  it.each([
    ['abc', "expand: tab size contains invalid character(s): 'abc'\n"],
    ['8x', "expand: tab size contains invalid character(s): 'x'\n"],
    ['-4', "expand: tab size contains invalid character(s): '-4'\n"],
    ['+x', "expand: tab size contains invalid character(s): 'x'\n"],
  ])('refuses --tabs=%s before reading anything', async (value, message) => {
    const got = await run({ tabs: value }, stdinOf('a\tb\n'))
    expect(got.exit).toBe(1)
    expect(got.stdout).toBe('')
    expect(got.stderr).toBe(message)
  })

  it('still expands a valid tab size', async () => {
    const got = await run({ tabs: '4' }, stdinOf('a\tb\n'))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('a   b\n')
    expect(got.stderr).toBe('')
  })

  // GNU accepts a leading `+` on every integer flag value and reads `+4`
  // as 4, so `--tabs=+4` is byte-identical to `--tabs=4`.
  it('accepts a leading plus as a sign', async () => {
    const got = await run({ tabs: '+4' }, stdinOf('a\tb\n'))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('a   b\n')
    expect(got.stderr).toBe('')
  })

  // `--tabs=''` is an empty tab-stop LIST, i.e. zero tab stops, which
  // leaves expand on its default 8 rather than being an error. expand is
  // the one flag in this family whose empty value succeeds.
  it('reads an empty tab list as the default size 8', async () => {
    const got = await run({ tabs: '' }, stdinOf('a\tb\n'))
    expect(got.exit).toBe(0)
    expect(got.stdout).toBe('a       b\n')
    expect(got.stderr).toBe('')
  })
})
