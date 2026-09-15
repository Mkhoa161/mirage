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
import { RAMResource } from '../../../resource/ram/ram.ts'
import { GENERAL_BC } from './bc.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function runBc(
  stdin: string,
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{ out: string; err: string; exitCode: number }> {
  const resource = new RAMResource()
  const cmd = GENERAL_BC[0]
  if (cmd === undefined) throw new Error('bc not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], [], {
    stdin: ENC.encode(stdin),
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { out: '', err: '', exitCode: -1 }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), err: await ioResult.stderrStr(), exitCode: ioResult.exitCode }
}

describe('bc', () => {
  it('simple addition', async () => {
    expect(await runBc('2+3\n')).toEqual({ out: '5\n', err: '', exitCode: 0 })
  })

  it('multiple lines', async () => {
    expect(await runBc('1+1\n2*3\n')).toEqual({ out: '2\n6\n', err: '', exitCode: 0 })
  })

  it('operator precedence', async () => {
    expect(await runBc('2+3*4\n')).toEqual({ out: '14\n', err: '', exitCode: 0 })
  })

  it('parentheses', async () => {
    expect(await runBc('(2+3)*4\n')).toEqual({ out: '20\n', err: '', exitCode: 0 })
  })

  it('exponentiation with ^', async () => {
    expect(await runBc('2^10\n')).toEqual({ out: '1024\n', err: '', exitCode: 0 })
  })

  it('right-associative ^', async () => {
    // 2^3^2 = 2^9 = 512
    expect(await runBc('2^3^2\n')).toEqual({ out: '512\n', err: '', exitCode: 0 })
  })

  it('floats keep the product scale', async () => {
    // `*` scales to min(1+0, max(scale, 1, 0)) = 1, so GNU prints 3.0.
    expect(await runBc('1.5*2\n')).toEqual({ out: '3.0\n', err: '', exitCode: 0 })
  })

  it('negative unary', async () => {
    expect(await runBc('-5+10\n')).toEqual({ out: '5\n', err: '', exitCode: 0 })
  })

  it('modulus', async () => {
    expect(await runBc('10%3\n')).toEqual({ out: '1\n', err: '', exitCode: 0 })
  })

  it('default scale is 0', async () => {
    expect(await runBc('scale\n')).toEqual({ out: '0\n', err: '', exitCode: 0 })
  })

  it('division truncates at the default scale', async () => {
    expect(await runBc('7/2\n')).toEqual({ out: '3\n', err: '', exitCode: 0 })
  })

  it('negative division truncates toward zero', async () => {
    expect(await runBc('-7/2\n')).toEqual({ out: '-3\n', err: '', exitCode: 0 })
  })

  it('remainder takes the dividend sign', async () => {
    expect(await runBc('-7%2\n')).toEqual({ out: '-1\n', err: '', exitCode: 0 })
  })

  it('scale is assignable and pads the quotient', async () => {
    expect(await runBc('scale=2; 7/2\n')).toEqual({ out: '3.50\n', err: '', exitCode: 0 })
  })

  it('addition keeps the wider operand scale and drops the leading zero', async () => {
    expect(await runBc('0.1+0.2\n')).toEqual({ out: '.3\n', err: '', exitCode: 0 })
  })

  it('a product that lands on a half rounds to even, as python does', async () => {
    expect(await runBc('1.5*1.5\n')).toEqual({ out: '2.2\n', err: '', exitCode: 0 })
  })

  it('an exact power prints every digit', async () => {
    expect(await runBc('2^100\n')).toEqual({
      out: '1267650600228229401496703205376\n',
      err: '',
      exitCode: 0,
    })
  })

  it('tabs are blanks, not a hard error', async () => {
    expect(await runBc('2\t+\t3\n')).toEqual({ out: '5\n', err: '', exitCode: 0 })
  })

  it('sqrt is a builtin, available without -l', async () => {
    expect(await runBc('sqrt(16)\n')).toEqual({ out: '4\n', err: '', exitCode: 0 })
  })

  it('a math-library name without -l errors', async () => {
    const r = await runBc('s(0)\n')
    expect(r.exitCode).toBe(1)
    expect(r.err).toBe('bc: identifiers not allowed without -l flag\n')
    expect(r.out).toBe('')
  })

  it('an unknown function under -l errors', async () => {
    const r = await runBc('zz(1)\n', { args_l: true })
    expect(r.exitCode).toBe(1)
    expect(r.err).toBe('bc: unknown function zz\n')
  })

  it('-l raises scale to 20', async () => {
    expect(await runBc('scale\n', { args_l: true })).toEqual({
      out: '20\n',
      err: '',
      exitCode: 0,
    })
  })

  it('-l stops division truncating', async () => {
    expect(await runBc('7/2\n', { args_l: true })).toEqual({
      out: '3.50000000000000000000\n',
      err: '',
      exitCode: 0,
    })
  })

  // The six functions under -l, at the float64 values both hosts share.
  // GNU is arbitrary precision, so its last digits differ on the
  // irrationals; that gap is accepted and documented, and what is pinned
  // here is what the python twin answers.
  it('-l sqrt', async () => {
    expect(await runBc('sqrt(2)\n', { args_l: true })).toEqual({
      out: '1.41421356237309514547\n',
      err: '',
      exitCode: 0,
    })
  })

  it('-l sine of zero is a bare zero', async () => {
    expect(await runBc('s(0)\n', { args_l: true })).toEqual({ out: '0\n', err: '', exitCode: 0 })
  })

  it('-l cosine of zero is padded', async () => {
    expect(await runBc('c(0)\n', { args_l: true })).toEqual({
      out: '1.00000000000000000000\n',
      err: '',
      exitCode: 0,
    })
  })

  it('-l arctangent of one', async () => {
    expect(await runBc('a(1)\n', { args_l: true })).toEqual({
      out: '.78539816339744827900\n',
      err: '',
      exitCode: 0,
    })
  })

  it('-l log of one is a bare zero', async () => {
    expect(await runBc('l(1)\n', { args_l: true })).toEqual({ out: '0\n', err: '', exitCode: 0 })
  })

  it('-l exponential of one', async () => {
    expect(await runBc('e(1)\n', { args_l: true })).toEqual({
      out: '2.71828182845904509080\n',
      err: '',
      exitCode: 0,
    })
  })

  it('divide by zero is non-fatal and later statements still run', async () => {
    expect(await runBc('1/0\n2+2\n')).toEqual({
      out: '4\n',
      err: 'Runtime error (func=(main), adr=3): Divide by zero\n',
      exitCode: 0,
    })
  })

  it('modulo by zero has its own wording', async () => {
    expect(await runBc('1%0\n')).toEqual({
      out: '',
      err: 'Runtime error (func=(main), adr=3): Modulo by zero\n',
      exitCode: 0,
    })
  })

  it('skips blank lines', async () => {
    expect(await runBc('1+1\n\n2+2\n')).toEqual({ out: '2\n4\n', err: '', exitCode: 0 })
  })

  it('an unbalanced paren is a parse error', async () => {
    const r = await runBc('(1+2\n')
    expect(r.exitCode).toBe(1)
    expect(r.err).toBe('bc: missing )\n')
  })
})
