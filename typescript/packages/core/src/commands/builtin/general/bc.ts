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
import { readStdinAsync } from '../utils/stream.ts'
import { pureProvision } from '../generic_bind/provision.ts'
import { FlagView } from '../../spec/types.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// Grammar, shared with `bc.py` so the two hosts parse one language
// (precedence low to high):
//   statement := 'scale' '=' expr | expr
//   expr      := term   { (+|-) term }
//   term      := unary  { (*|/|%) unary }
//   unary     := (+|-) unary | power
//   power     := atom ^ unary | atom
//   atom      := number | '(' expr ')' | 'scale' | func '(' expr ')'
//               | func atom
//   func      := sqrt | s | c | a | l | e   (all but sqrt need -l)

// `-l` loads the math library, which sets scale to 20. Without it bc's
// scale is 0, which is why plain `7/2` is 3 and `bc -l` answers 3.50...
const MATH_LIBRARY_SCALE = 20

// The largest scale either host can render. `Number.prototype.toFixed`
// refuses a fractionDigits above 100, so a larger scale could not be
// printed identically by the python twin; it also bounds what a typed
// `scale=` can make this allocate. GNU bc accepts more, which is a
// documented divergence.
const MAX_SCALE = 100

// GNU renders a non-fatal runtime error with the bytecode address it
// happened at. The address depends on everything parsed before it, so it
// is not derivable here; 3 is what GNU emits for a bare `1/0` as the
// first statement, which is the measured case, and both hosts use the
// same constant so parity holds for the rest.
const RUNTIME_ERROR_ADDR = 3

const DIVIDE_BY_ZERO = 'Divide by zero'
const MODULO_BY_ZERO = 'Modulo by zero'

// Input bc cannot parse at all; the run stops and exits 1.
class BcError extends Error {}

// A non-fatal runtime error: reported, then evaluation continues.
class BcRuntimeError extends Error {}

// A bc value and the number of fractional digits it prints with. bc
// tracks a scale per value, not just globally, which is the whole
// reason `0.1+0.2` prints `.3` at the default scale of 0: addition
// keeps the wider of its operands' scales, while division adopts the
// global one.
interface BcNumber {
  readonly value: number
  readonly scale: number
}

// What survives between statements on one bc run: the global `scale`
// register and whether `-l` loaded the math library.
interface BcState {
  scale: number
  mathMode: boolean
}

type MathFn = (x: number) => number

// The math library, whose members are reachable only under -l. `sqrt` is
// not one of them: GNU bc has it built in, so it answers without the
// flag, and it is dispatched separately below. Python wraps these to
// reach JavaScript's answers at the domain edges (`Math.log(0)` is
// -Infinity where `math.log` raises, `Math.exp` saturates to Infinity,
// `Math.sqrt(-1)` is NaN); here the platform already answers that way.
const MATH_FUNCS = new Map<string, MathFn>([
  ['s', Math.sin],
  ['c', Math.cos],
  ['a', Math.atan],
  ['l', Math.log],
  ['e', Math.exp],
])

const SQRT_NAME = 'sqrt'
const SCALE_NAME = 'scale'

const DIGITS = /[0-9.]/
// ASCII only, matching `NAME_CHARS` in the python twin.
const NAME_CHARS = /[a-z]/
const BLANKS = /[ \t]/

// Hold a scale inside the range both hosts can render.
function clampScale(scale: number): number {
  return Math.max(0, Math.min(scale, MAX_SCALE))
}

// `base ** exponent`, refusing what bc reports as a divide by zero.
// JavaScript saturates an overflow to a signed Infinity on its own,
// which is what the python twin's `float_pow` reproduces.
function floatPow(base: number, exponent: number): number {
  if (base === 0 && exponent < 0) throw new BcRuntimeError(DIVIDE_BY_ZERO)
  return base ** exponent
}

// The `10.0 ** scale` the python twin computes. V8's `**` and CPython's
// float pow disagree by one ulp on 13 of the scales in range, and the
// last digit of a truncation rides on the factor, so it is read as a
// correctly-rounded literal instead. That matches CPython at every
// scale where CPython's own pow is correctly rounded, which is all of
// 0..100 but 23.
function powerOfTen(scale: number): number {
  return Number(`1e${String(scale)}`)
}

// Drop the digits past `scale`, rounding toward zero as bc does.
function truncateToScale(value: number, scale: number): number {
  const factor = powerOfTen(scale)
  const scaled = value * factor
  if (!Number.isFinite(scaled)) return value
  return Math.trunc(scaled) / factor
}

// Spell an infinity or NaN as `String` spells it. GNU bc is exact and
// has no such value, so there is nothing to match against; matching the
// other host is what is left.
function nonfiniteText(value: number): string {
  return String(value)
}

// Whether `value` sits exactly halfway between two renderings at
// `scale`. Such a value is an odd multiple of 2^-(scale+1), so the
// product below is an odd integer; a value too big for that product to
// stay finite cannot be halfway.
function isHalfway(value: number, scale: number): boolean {
  // `toFixed` refuses a scale above 100, and the correction below reads
  // one digit deeper. A tie that deep is an odd multiple of 2^-101,
  // which no bc arithmetic here produces.
  if (scale >= MAX_SCALE) return false
  const doubled = value * 2 ** (scale + 1)
  return Number.isInteger(doubled) && Math.abs(doubled % 2) === 1
}

// The neighbour `value` rounds to toward zero at `scale`.
function towardZero(value: number, scale: number): string {
  const text = value.toFixed(scale + 1).slice(0, -1)
  return text.endsWith('.') ? text.slice(0, -1) : text
}

// The twin of python's `f"{value:.{scale}f}"`, which the two hosts have
// to agree on byte for byte. Two places `toFixed` alone does not:
// it answers in exponential notation from 1e21 up, where python keeps
// printing digits (every double that big is an integer, so the fraction
// is only padding); and it rounds a tie away from zero where python
// rounds it to even, which would split the hosts on every product that
// lands on a half, e.g. `0.5*0.5` at scale 1.
function formatFixed(value: number, scale: number): string {
  if (Math.abs(value) >= 1e21) {
    const digits = BigInt(value).toString()
    return scale === 0 ? digits : `${digits}.${'0'.repeat(scale)}`
  }
  const away = value.toFixed(scale)
  if (!isHalfway(value, scale)) return away
  const lastDigit = Number(away.charAt(away.length - 1))
  return lastDigit % 2 === 0 ? away : towardZero(value, scale)
}

// Render one printed bc value. Two GNU spellings that are easy to miss:
// an exact zero prints as a bare `0` whatever the scale, and a value
// below one carries no leading zero, so `0.1+0.2` is `.3`, not `0.3`.
function renderNumber(num: BcNumber): string {
  if (!Number.isFinite(num.value)) return nonfiniteText(num.value)
  if (num.value === 0) return '0'
  const text = formatFixed(num.value, clampScale(num.scale))
  if (text.startsWith('0.')) return text.slice(1)
  if (text.startsWith('-0.')) return '-' + text.slice(2)
  return text
}

function runtimeErrorLine(reason: string): string {
  return `Runtime error (func=(main), adr=${String(RUNTIME_ERROR_ADDR)}): ${reason}`
}

// The scale bc gives a sum or difference: the wider of the two operands.
function addScale(a: BcNumber, b: BcNumber): number {
  return clampScale(Math.max(a.scale, b.scale))
}

// The scale bc gives a product:
// `min(scale(a)+scale(b), max(scale, scale(a), scale(b)))`.
function mulScale(a: BcNumber, b: BcNumber, scale: number): number {
  return clampScale(Math.min(a.scale + b.scale, Math.max(scale, a.scale, b.scale)))
}

// The scale bc gives a power: the global scale for a negative exponent,
// otherwise `min(scale(a)*exponent, max(scale, scale(a)))`.
function powScale(a: BcNumber, exponent: number, scale: number): number {
  if (exponent < 0) return clampScale(scale)
  return clampScale(Math.min(a.scale * exponent, Math.max(scale, a.scale)))
}

// bc's `/`: truncate the quotient to the global scale.
function divide(a: BcNumber, b: BcNumber, scale: number): BcNumber {
  if (b.value === 0) throw new BcRuntimeError(DIVIDE_BY_ZERO)
  return { value: truncateToScale(a.value / b.value, scale), scale: clampScale(scale) }
}

// bc's `%`: `a - (a/b)*b`, with the quotient truncated to the global
// scale first, so the remainder takes the dividend's sign and `-7%2` is
// -1. JavaScript's own `%` agrees only at scale 0.
function modulo(a: BcNumber, b: BcNumber, scale: number): BcNumber {
  if (b.value === 0) throw new BcRuntimeError(MODULO_BY_ZERO)
  const quotient = truncateToScale(a.value / b.value, scale)
  return {
    value: a.value - quotient * b.value,
    scale: clampScale(Math.max(scale + b.scale, a.scale)),
  }
}

// Apply one built-in or math-library function, at `max(scale, scale(arg))`.
function callFunction(name: string, arg: BcNumber, scale: number): BcNumber {
  const fn = name === SQRT_NAME ? Math.sqrt : MATH_FUNCS.get(name)
  if (fn === undefined) throw new BcError(`bc: unknown function ${name}`)
  return { value: fn(arg.value), scale: clampScale(Math.max(scale, arg.scale)) }
}

// A recursive-descent parser for one bc statement, mirroring `Parser` in
// `bc.py` method for method so the two hosts accept and refuse the same
// lines.
class Parser {
  private pos = 0
  constructor(
    private readonly src: string,
    private readonly state: BcState,
  ) {}

  private skipBlanks(): void {
    while (this.pos < this.src.length && BLANKS.test(this.src.charAt(this.pos))) this.pos++
  }

  private peek(): string {
    this.skipBlanks()
    return this.src[this.pos] ?? ''
  }

  private consume(): string {
    const c = this.peek()
    this.pos++
    return c
  }

  private match(s: string): boolean {
    this.skipBlanks()
    if (this.src.startsWith(s, this.pos)) {
      this.pos += s.length
      return true
    }
    return false
  }

  private readNumber(): BcNumber {
    const start = this.pos
    while (this.pos < this.src.length && DIGITS.test(this.src.charAt(this.pos))) this.pos++
    const raw = this.src.slice(start, this.pos)
    // `Number` rather than `Number.parseFloat`, which would read `1.2.3`
    // as 1.2 where python's `float` refuses it.
    const value = Number(raw)
    if (Number.isNaN(value)) throw new BcError(`bc: invalid number: ${raw}`)
    const dot = raw.indexOf('.')
    const fraction = dot === -1 ? '' : raw.slice(dot + 1)
    return { value, scale: clampScale(fraction.length) }
  }

  private readIdentifier(): string {
    const start = this.pos
    while (this.pos < this.src.length && NAME_CHARS.test(this.src.charAt(this.pos))) this.pos++
    return this.src.slice(start, this.pos)
  }

  // Parse one statement, answering null for an assignment, which bc
  // prints nothing for.
  parseStatement(): string | null {
    if (this.tryScaleAssignment()) {
      const value = this.parseExpr()
      this.state.scale = clampScale(Math.trunc(value.value))
      return null
    }
    return renderNumber(this.parseExpr())
  }

  private tryScaleAssignment(): boolean {
    const mark = this.pos
    this.skipBlanks()
    if (this.readIdentifier() !== SCALE_NAME) {
      this.pos = mark
      return false
    }
    this.skipBlanks()
    const rest = this.src.slice(this.pos)
    if (!rest.startsWith('=') || rest.startsWith('==')) {
      this.pos = mark
      return false
    }
    this.pos += 1
    return true
  }

  parseExpr(): BcNumber {
    let left = this.parseTerm()
    for (;;) {
      const c = this.peek()
      if (c === '+') {
        this.consume()
        const right = this.parseTerm()
        left = { value: left.value + right.value, scale: addScale(left, right) }
      } else if (c === '-') {
        this.consume()
        const right = this.parseTerm()
        left = { value: left.value - right.value, scale: addScale(left, right) }
      } else {
        return left
      }
    }
  }

  private parseTerm(): BcNumber {
    let left = this.parseUnary()
    for (;;) {
      const c = this.peek()
      if (c === '*') {
        this.consume()
        const right = this.parseUnary()
        left = {
          value: left.value * right.value,
          scale: mulScale(left, right, this.state.scale),
        }
      } else if (c === '/') {
        this.consume()
        left = divide(left, this.parseUnary(), this.state.scale)
      } else if (c === '%') {
        this.consume()
        left = modulo(left, this.parseUnary(), this.state.scale)
      } else {
        return left
      }
    }
  }

  private parseUnary(): BcNumber {
    const c = this.peek()
    if (c === '-') {
      this.consume()
      const operand = this.parseUnary()
      return { value: -operand.value, scale: operand.scale }
    }
    if (c === '+') {
      this.consume()
      return this.parseUnary()
    }
    return this.parsePower()
  }

  private parsePower(): BcNumber {
    const base = this.parseAtom()
    if (this.peek() !== '^') return base
    this.consume()
    const rawExponent = this.parseUnary()
    const exponent = Math.trunc(rawExponent.value)
    return {
      value: floatPow(base.value, exponent),
      scale: powScale(base, exponent, this.state.scale),
    }
  }

  private parseAtom(): BcNumber {
    const c = this.peek()
    if (c === '') throw new BcError('bc: unexpected end of expression')
    if (c === '(') {
      this.consume()
      const val = this.parseExpr()
      if (!this.match(')')) throw new BcError('bc: missing )')
      return val
    }
    if (DIGITS.test(c)) return this.readNumber()
    if (NAME_CHARS.test(c)) return this.parseName()
    throw new BcError(`bc: unexpected character "${c}"`)
  }

  private parseName(): BcNumber {
    const name = this.readIdentifier()
    if (name === SCALE_NAME) return { value: this.state.scale, scale: 0 }
    const known = name === SQRT_NAME || (this.state.mathMode && MATH_FUNCS.has(name))
    if (!known) {
      throw new BcError(
        this.state.mathMode
          ? `bc: unknown function ${name}`
          : 'bc: identifiers not allowed without -l flag',
      )
    }
    if (this.match('(')) {
      const arg = this.parseExpr()
      if (!this.match(')')) throw new BcError('bc: missing )')
      return callFunction(name, arg, this.state.scale)
    }
    return callFunction(name, this.parseAtom(), this.state.scale)
  }

  // Whether the whole statement was consumed.
  done(): boolean {
    this.skipBlanks()
    return this.pos >= this.src.length
  }
}

// Evaluate one bc statement against the run's state, answering null for
// an assignment.
function evalStatement(text: string, state: BcState): string | null {
  const parser = new Parser(text, state)
  const rendered = parser.parseStatement()
  if (!parser.done()) throw new BcError('bc: trailing input')
  return rendered
}

// Split bc input into statements on newlines and semicolons.
function splitStatements(text: string): string[] {
  const statements: string[] = []
  for (const line of text.trim().split('\n')) {
    for (const piece of line.split(';')) {
      const trimmed = piece.trim()
      if (trimmed !== '') statements.push(trimmed)
    }
  }
  return statements
}

async function bcCommand(
  _accessor: Accessor,
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('bc'))
  // -l is short-only, so it lands on the disambiguated `args_l` dest
  // (`AMBIGUOUS_NAMES`); a plain `l` key is one the parser never emits.
  const useMath = fl.asBool('args_l')
  const raw = (await readStdinAsync(opts.stdin)) ?? new Uint8Array(0)
  const state: BcState = { scale: useMath ? MATH_LIBRARY_SCALE : 0, mathMode: useMath }
  const results: string[] = []
  const errors: string[] = []
  for (const statement of splitStatements(DEC.decode(raw))) {
    let rendered: string | null
    try {
      rendered = evalStatement(statement, state)
    } catch (err) {
      if (err instanceof BcRuntimeError) {
        // GNU treats this as non-fatal: it names the error on stderr,
        // prints nothing for the statement, keeps evaluating the rest
        // and still exits 0.
        errors.push(runtimeErrorLine(err.message))
        continue
      }
      if (err instanceof BcError) {
        errors.push(err.message)
        return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(errors.join('\n') + '\n') })]
      }
      throw err
    }
    if (rendered !== null) results.push(rendered)
  }
  const stdout = results.length > 0 ? ENC.encode(results.join('\n') + '\n') : new Uint8Array(0)
  const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : null
  return [stdout, new IOResult({ stderr })]
}

export const GENERAL_BC = command({
  name: 'bc',
  resource: null,
  spec: specOf('bc'),
  fn: bcCommand,
  provision: pureProvision,
})
