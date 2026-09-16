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

import { flagKwargName } from './constants.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { CommandSpec, FlagValue } from './types.ts'

/**
 * Collect the kwarg names a spec's options can produce.
 *
 * One name per option: the long spelling when an option declares both,
 * matching the parser's canonical dest. Keeping the short spelling here
 * too would let a stale `fl.asBool('a')` stay legal and read false
 * forever after dest unification; canonical-only turns that silent miss
 * into a throw. Mirrors Python's `spec_flag_names`.
 */
export function specFlagNames(spec: CommandSpec): ReadonlySet<string> {
  const names = new Set<string>()
  for (const option of spec.options) {
    const canonical = option.long ?? option.short
    if (canonical !== null) names.add(flagKwargName(canonical))
  }
  return names
}

/**
 * Typed read-only view over raw flag kwargs.
 *
 * Commands receive flags as an untyped record from the dispatcher; this
 * view is the one sanctioned way to read them, replacing ad-hoc
 * `flags.x === true` checks and typeof chains. Mirrors Python's
 * `FlagView`.
 *
 * When constructed with a spec, reading a name the spec does not declare
 * throws. A missing key is otherwise indistinguishable from "flag not
 * passed", so a typo in the name would silently read as false/undefined.
 */
export class FlagView {
  private readonly flags: Readonly<Record<string, FlagValue>>
  private readonly allowed: ReadonlySet<string> | null
  // The parser's per-occurrence record of the scalar value flags the line
  // carried (`CommandOpts.valueOccurrences`), which `valueOccurrences`
  // answers from; undefined means no record was taken and the bag is read
  // as the record.
  private readonly occurrences: readonly (readonly [string, string])[] | undefined

  constructor(
    flags?: Readonly<Record<string, FlagValue>>,
    spec?: CommandSpec,
    occurrences?: readonly (readonly [string, string])[],
  ) {
    this.flags = flags ?? {}
    this.allowed = spec === undefined ? null : specFlagNames(spec)
    this.occurrences = occurrences
  }

  private key(name: string): string {
    if (this.allowed !== null && !this.allowed.has(name)) {
      throw new Error(
        `flag '${name}' is not declared by the command spec ` +
          `(known: ${[...this.allowed].sort(compareCodePoints).join(', ')})`,
      )
    }
    return name
  }

  /**
   * The given flag names, ordered by their recorded occurrences.
   *
   * The parser fills the bag in scan order and every hop between
   * (object spreads, copies) preserves string-key insertion order, so
   * a key's position is its last occurrence for scalars, first for accumulating options; a flag
   * supplied by a default or the environment lands after every typed
   * one. Names the line never carried are dropped. This is what an
   * order-sensitive option family (grep's --include/--exclude, where
   * the later kind overrides the earlier) reads, since the bag has no
   * per-occurrence positions.
   */
  typedOrder(...names: string[]): string[] {
    const wanted = new Set(names.map((n) => this.key(n)))
    return Object.keys(this.flags).filter((k) => wanted.has(k))
  }

  /**
   * The named options' occurrences, in the order the line typed them.
   *
   * `typedOrder` can only answer out of the bag, which keeps one value
   * per scalar option — the LAST occurrence of a repeated one. GNU
   * validates each value the moment getopt hands it over, so a command
   * that has to answer for the leftmost bad value (`nl -w abc -w 3`
   * refuses `abc`) or refuse a repeat outright (`shuf -i 1-2 -i 3-4`)
   * needs the occurrences the bag threw away. The parser records every
   * scalar value-flag occurrence as it scans and the dispatcher hands that
   * record over as `CommandOpts.valueOccurrences`, which is the
   * `occurrences` this view was built with. Without one (a view built
   * straight from a bag, outside a dispatch) the bag is read as the record:
   * that is exact for a line that typed each dest once, since its bag
   * position is that one occurrence.
   *
   * Values are raw argv text: a PATH-typed option's value is the word as
   * typed, not the resolved path, and the bare boolean form of an
   * optional-value flag carries no value and so does not appear.
   * Mirrors Python's `FlagView.value_occurrences`.
   */
  valueOccurrences(...names: string[]): [string, string][] {
    const wanted = new Set(names.map((n) => this.key(n)))
    if (this.occurrences !== undefined) {
      const pairs: [string, string][] = []
      for (const [dest, value] of this.occurrences) if (wanted.has(dest)) pairs.push([dest, value])
      return pairs
    }
    const recorded: [string, string][] = []
    for (const dest of this.typedOrder(...names)) {
      const value = this.flags[dest]
      if (typeof value === 'string') recorded.push([dest, value])
    }
    return recorded
  }

  asBool(name: string): boolean {
    const value = this.flags[this.key(name)]
    if (typeof value === 'boolean') return value
    // A count flag holds a number; any occurrence reads as set.
    return typeof value === 'number' && value > 0
  }

  asInt(name: string): number | undefined {
    const value = this.flags[this.key(name)]
    if (typeof value === 'number') return value
    if (typeof value !== 'string') return undefined
    // Python's int() is all-or-nothing: it accepts surrounding whitespace
    // and underscore separators and raises on anything else. parseInt would
    // instead take the numeric prefix of '5x' and hand back NaN for 'abc',
    // and NaN still satisfies `number`, so a bad value would flow onward as
    // a number rather than being rejected.
    const text = value.trim()
    if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) {
      throw new Error(`flag '${name}' expects an integer, got '${value}'`)
    }
    return Number.parseInt(text.replaceAll('_', ''), 10)
  }

  asFloat(name: string): number | undefined {
    const value = this.flags[this.key(name)]
    if (typeof value === 'number') return value
    if (typeof value !== 'string') return undefined
    // All-or-nothing like Python's float(), mirroring asInt: parseFloat
    // would take the numeric prefix of '2.5x' and hand back NaN for
    // 'abc', and NaN still satisfies `number`.
    const text = value.trim()
    if (
      !/^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/.test(
        text,
      )
    ) {
      throw new Error(`flag '${name}' expects a number, got '${value}'`)
    }
    return Number.parseFloat(text.replaceAll('_', ''))
  }

  asStr(name: string): string | undefined {
    const value = this.flags[this.key(name)]
    return typeof value === 'string' ? value : undefined
  }

  asList(name: string): string[] {
    const value = this.flags[this.key(name)]
    if (Array.isArray(value)) return value.filter((v) => typeof v === 'string')
    if (typeof value === 'string') return [value]
    return []
  }

  raw(name: string): FlagValue | undefined {
    return this.flags[this.key(name)]
  }
}
