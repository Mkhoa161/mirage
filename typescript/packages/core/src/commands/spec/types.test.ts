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
import { compileSpec } from './compile.ts'
import { CommandSpec, Operand, Option } from './types.ts'

describe('ValueType', () => {
  it('covers the five members through Option', () => {
    expect(new Option({ short: '-v' }).type).toBe('bool')
    expect(new Option({ long: '--x', type: 'str' }).type).toBe('str')
    expect(new Option({ long: '--n', type: 'int' }).type).toBe('int')
    expect(new Option({ long: '--r', type: 'float' }).type).toBe('float')
    expect(new Option({ long: '--f', type: 'path' }).type).toBe('path')
  })
})

describe('Option', () => {
  it('defaults type to bool', () => {
    const o = new Option({ short: '-l' })
    expect(o.type).toBe('bool')
    expect(o.short).toBe('-l')
    expect(o.long).toBeNull()
  })

  it('is frozen', () => {
    const o = new Option()
    expect(Object.isFrozen(o)).toBe(true)
  })

  it('copies and freezes choices', () => {
    const choices = ['a']
    const o = new Option({ long: '--mode', type: 'str', choices })
    choices.push('b')

    expect(o.choices).toEqual(['a'])
    expect(Object.isFrozen(o.choices)).toBe(true)
  })
})

describe('Operand', () => {
  it('defaults type to path', () => {
    expect(new Operand().type).toBe('path')
  })

  it('copies and freezes conditional flag lists', () => {
    const providedBy = ['--pattern']
    const textWhen = ['--args']
    const operand = new Operand({ providedBy, textWhen })
    providedBy.push('--file')
    textWhen.push('--raw-input')

    expect(operand.providedBy).toEqual(['--pattern'])
    expect(operand.textWhen).toEqual(['--args'])
    expect(Object.isFrozen(operand.providedBy)).toBe(true)
    expect(Object.isFrozen(operand.textWhen)).toBe(true)
  })
})

describe('CommandSpec', () => {
  it('defaults to empty options/positional + null rest', () => {
    const s = new CommandSpec()
    expect(s.options).toEqual([])
    expect(s.positional).toEqual([])
    expect(s.rest).toBeNull()
  })

  it('owns immutable copies of nested collections', () => {
    const choices = ['one']
    const providedBy = ['--expr']
    const options = [new Option({ long: '--mode', choices })]
    const positional = [new Operand({ providedBy })]
    const ignoreTokens = ['!']
    const spec = new CommandSpec({ options, positional, ignoreTokens })

    choices.push('two')
    providedBy.push('--file')
    options.push(new Option({ long: '--later' }))
    positional.push(new Operand())
    ignoreTokens.push('?')

    expect(spec.options).toHaveLength(1)
    expect(spec.options[0]?.choices).toEqual(['one'])
    expect(spec.positional).toHaveLength(1)
    expect(spec.positional[0]?.providedBy).toEqual(['--expr'])
    expect([...spec.ignoreTokens]).toEqual(['!'])
    expect(() => (spec.options as Option[]).push(new Option())).toThrow()
    expect(() => (spec.options[0]?.choices as string[]).push('three')).toThrow()
    expect(() => (spec.positional as Operand[]).push(new Operand())).toThrow()
    expect(() => (spec.positional[0]?.providedBy as string[]).push('--pattern')).toThrow()
    expect(() => (spec.ignoreTokens as Set<string>).add('?')).toThrow()
  })

  it('copies and freezes grammar arrays before compilation caches them', () => {
    const option = new Option({ long: '--mode', type: 'str' })
    const operand = new Operand({ type: 'str' })
    const options = [option]
    const positional = [operand]
    const spec = new CommandSpec({ options, positional })
    const compiled = compileSpec(spec)
    options.push(new Option({ long: '--later' }))
    positional.push(new Operand({ type: 'path' }))

    expect(spec.options).toEqual([option])
    expect(spec.positional).toEqual([operand])
    expect(Object.isFrozen(spec.options)).toBe(true)
    expect(Object.isFrozen(spec.positional)).toBe(true)
    expect(compileSpec(spec)).toBe(compiled)
  })
})

describe('CommandSpec.description', () => {
  it('defaults to null', () => {
    const spec = new CommandSpec()
    expect(spec.description).toBeNull()
  })

  it('round-trips an explicit value', () => {
    const spec = new CommandSpec({ description: 'do a thing' })
    expect(spec.description).toBe('do a thing')
  })
})

describe('Option.description', () => {
  it('defaults to null', () => {
    const opt = new Option({ short: 'n' })
    expect(opt.description).toBeNull()
  })

  it('round-trips an explicit value', () => {
    const opt = new Option({ short: 'n', description: 'number lines' })
    expect(opt.description).toBe('number lines')
  })
})
