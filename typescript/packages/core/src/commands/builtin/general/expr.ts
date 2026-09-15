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

import type { PathSpec } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { pureProvision } from '../generic_bind/provision.ts'

const ENC = new TextEncoder()

const ARITH_OPS = new Set(['+', '-', '*', '/', '%'])
const CMP_OPS = new Set(['=', '!=', '<', '>', '<=', '>='])

// GNU expr's operand grammar, which is narrower than either language's
// own integer parser: no sign but a leading `-`, no surrounding space,
// no digit separator, no `0x`/`1e3` form. Leading zeros are decimal, so
// `05` is 5. `\d` is ASCII-only in JavaScript, matching `[0-9]` in the
// python twin (`INT_OPERAND_RE`, expr.py).
//
// The grammar is shared but the precision is not: GNU expr and the python
// twin are arbitrary precision, while an operand read here becomes a
// float64 and so cannot be answered exactly past 2**53. That gap predates
// this parser and no case pins a value that large; closing it means
// BigInt arithmetic throughout, which is its own change.
const INT_OPERAND_RE = /^-?\d+$/

const NON_INTEGER = 'expr: non-integer argument'
const DIVISION_BY_ZERO = 'expr: division by zero'

// An operand or operation GNU expr refuses, worded as GNU words it.
class ExprError extends Error {}

// One expr operand read as GNU reads it, or null when it is not an
// integer in GNU's grammar -- the read a comparison uses, since a
// comparison falls back to comparing strings instead of refusing.
function intOperandOrNone(s: string): number | null {
  if (!INT_OPERAND_RE.test(s)) return null
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

// The same read for an arithmetic operand, which GNU refuses outright.
function parseIntOperand(s: string): number {
  const n = intOperandOrNone(s)
  if (n === null) throw new ExprError(NON_INTEGER)
  return n
}

// Integer division truncated toward zero, as C and GNU expr do it.
// JavaScript's `/` is exact here only because the quotient is trimmed
// with `Math.trunc`; a zero divisor is GNU's `division by zero`, not
// an Infinity on stdout.
function truncDiv(a: number, b: number): number {
  if (b === 0) throw new ExprError(DIVISION_BY_ZERO)
  return Math.trunc(a / b)
}

// The remainder that takes the dividend's sign, as GNU expr does:
// `-10 % 3` is -1 and `10 % -3` is 1, which JavaScript's own `%`
// already answers. GNU reports a zero divisor here with the same
// `division by zero` message it uses for `/`, not a modulo variant.
function truncMod(a: number, b: number): number {
  if (b === 0) throw new ExprError(DIVISION_BY_ZERO)
  return a % b
}

function exprEval(args: string[]): [string, number] {
  if (args.length === 3 && args[1] === ':') {
    const [str, , pattern] = args as [string, string, string]
    // Python `re.match` is anchored at the start. Mirror that.
    const re = new RegExp('^(?:' + pattern + ')')
    const m = re.exec(str)
    let result: string
    if (m === null) {
      result = ''
    } else if (m.length > 1 && m[1] !== undefined) {
      result = m[1]
    } else {
      result = String(m[0].length)
    }
    const exitCode = result === '' || result === '0' ? 1 : 0
    return [result, exitCode]
  }
  if (args.length === 3 && typeof args[1] === 'string' && ARITH_OPS.has(args[1])) {
    const a = parseIntOperand(args[0] ?? '')
    const b = parseIntOperand(args[2] ?? '')
    let val: number
    switch (args[1]) {
      case '+':
        val = a + b
        break
      case '-':
        val = a - b
        break
      case '*':
        val = a * b
        break
      case '/':
        val = truncDiv(a, b)
        break
      default:
        val = truncMod(a, b)
        break
    }
    const result = String(val)
    // GNU expr exits 1 when the value is `0` or empty even on full
    // success, so exit 1 means "the answer was zero" and exit 2 is the
    // only error status.
    const exitCode = result === '0' ? 1 : 0
    return [result, exitCode]
  }
  if (args.length === 3 && typeof args[1] === 'string' && CMP_OPS.has(args[1])) {
    const [left, op, right] = args as [string, string, string]
    const l = intOperandOrNone(left)
    const r = intOperandOrNone(right)
    let cmp: boolean
    if (l !== null && r !== null) {
      switch (op) {
        case '=':
          cmp = l === r
          break
        case '!=':
          cmp = l !== r
          break
        case '<':
          cmp = l < r
          break
        case '>':
          cmp = l > r
          break
        case '<=':
          cmp = l <= r
          break
        case '>=':
          cmp = l >= r
          break
        default:
          cmp = false
          break
      }
    } else {
      switch (op) {
        case '=':
          cmp = left === right
          break
        case '!=':
          cmp = left !== right
          break
        case '<':
          cmp = left < right
          break
        case '>':
          cmp = left > right
          break
        case '<=':
          cmp = left <= right
          break
        case '>=':
          cmp = left >= right
          break
        default:
          cmp = false
          break
      }
    }
    const val = cmp ? 1 : 0
    const result = String(val)
    const exitCode = result === '0' ? 1 : 0
    return [result, exitCode]
  }
  return ['', 2]
}

function exprCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  _opts: CommandOpts,
): CommandFnResult {
  if (texts.length === 0) {
    return [ENC.encode('\n'), new IOResult({ exitCode: 2 })]
  }
  try {
    const [result, exitCode] = exprEval(texts)
    return [ENC.encode(result + '\n'), new IOResult({ exitCode })]
  } catch (err) {
    if (err instanceof ExprError) {
      // GNU writes the refusal to stderr, nothing to stdout, and exits
      // 2; exit 1 is reserved for a zero-valued success.
      return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${err.message}\n`) })]
    }
    throw err
  }
}

export const GENERAL_EXPR = command({
  name: 'expr',
  resource: null,
  spec: specOf('expr'),
  fn: exprCommand,
  provision: pureProvision,
})
