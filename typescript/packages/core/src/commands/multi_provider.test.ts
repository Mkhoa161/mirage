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
import { command, hasInjectedVersion, RegisteredCommand, versionRequest } from './config.ts'
import { BUILTIN_SPECS, registeredSpec } from './spec/builtins.ts'
import { CommandSpec, Operand, Option } from './spec/types.ts'
import { IOResult } from '../io/types.ts'

const noopFn = (): Promise<[Uint8Array, IOResult]> =>
  Promise.resolve([new Uint8Array(), new IOResult()])

function specFor(name: string, spec = new CommandSpec()): CommandSpec | null {
  return command({ name, resource: 'disk', spec, fn: noopFn })[0]?.spec ?? null
}

function decode(out: Uint8Array | null): string | null {
  return out === null ? null : new TextDecoder().decode(out)
}

// The one enriched copy the registry parses for a builtin, which is what a
// line meets at parse time; a hand-built lookalike is not that spec.
function builtinSpec(name: string): CommandSpec {
  const spec = BUILTIN_SPECS[name]
  if (spec === undefined) throw new Error(`no builtin spec for ${name}`)
  return registeredSpec(name, spec)
}

describe('command() registers multiple resources', () => {
  it('returns one RegisteredCommand per resource when passed an array', () => {
    const cmds = command({
      name: 'cat',
      resource: ['gdocs', 'gdrive'],
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(2)
    const resources = cmds.map((c) => c.resource)
    expect(resources).toContain('gdocs')
    expect(resources).toContain('gdrive')
    for (const c of cmds) {
      expect(c).toBeInstanceOf(RegisteredCommand)
      expect(c.name).toBe('cat')
    }
  })

  it('single-resource string still produces one RegisteredCommand', () => {
    const cmds = command({
      name: 'ls',
      resource: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(1)
    const first = cmds[0]
    expect(first).toBeDefined()
    expect(first?.resource).toBe('disk')
  })

  it('null resource produces a general-registered command', () => {
    const cmds = command({
      name: 'echo',
      resource: null,
      spec: new CommandSpec(),
      fn: noopFn,
    })
    expect(cmds).toHaveLength(1)
    expect(cmds[0]?.resource).toBeNull()
  })

  it('auto-injects --help into spec.options', () => {
    const cmds = command({
      name: 'foo',
      resource: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    const helpOpt = cmds[0]?.spec.options.find((o) => o.long === '--help')
    expect(helpOpt).toBeDefined()
  })

  it('--help short-circuits the handler and returns rendered help', async () => {
    let handlerCalled = false
    const cmds = command({
      name: 'bar',
      resource: 'disk',
      spec: new CommandSpec({ description: 'do bar' }),
      fn: () => {
        handlerCalled = true
        return Promise.resolve([new Uint8Array(), new IOResult()])
      },
    })
    const opts = {
      stdin: null,
      flags: { help: true },
      filetypeFns: null,
      cwd: '/',
      resource: {} as never,
    }
    const result = await cmds[0]?.fn({} as never, [], [], opts)
    expect(handlerCalled).toBe(false)
    const stdout = result?.[0]
    expect(stdout).toBeDefined()
    const text = new TextDecoder().decode(stdout as Uint8Array)
    expect(text).toContain('bar: do bar')
    expect(text).toContain('--help')
  })

  it('auto-injects --version into spec.options', () => {
    const cmds = command({
      name: 'foo',
      resource: 'disk',
      spec: new CommandSpec(),
      fn: noopFn,
    })
    const versionOpt = cmds[0]?.spec.options.find((o) => o.long === '--version')
    expect(versionOpt).toBeDefined()
  })

  it('--version short-circuits the handler and returns package version', async () => {
    let handlerCalled = false
    const cmds = command({
      name: 'tsort',
      resource: 'disk',
      spec: new CommandSpec(),
      fn: () => {
        handlerCalled = true
        return Promise.resolve([new Uint8Array(), new IOResult()])
      },
    })
    const opts = {
      stdin: null,
      flags: { version: true },
      filetypeFns: null,
      cwd: '/',
      resource: {} as never,
    }
    const result = await cmds[0]?.fn({} as never, [], [], opts)
    expect(handlerCalled).toBe(false)
    const stdout = result?.[0]
    expect(stdout).toBeDefined()
    const text = new TextDecoder().decode(stdout as Uint8Array)
    expect(text).toMatch(/^tsort \(Mirage\) \d+\.\d+\.\d+(?:-[\w.]+)?\n$/)
  })
})

describe('versionRequest', () => {
  it('matches the injected option', () => {
    const out = versionRequest('tsort', specFor('tsort'), ['--version'])
    expect(decode(out)).toMatch(/^tsort \(Mirage\) \d+\.\d+\.\d+(?:-[\w.]+)?\n$/)
  })

  it('is null without the flag', () => {
    expect(versionRequest('tsort', specFor('tsort'), ['/data/a.txt'])).toBeNull()
  })

  it('is null after the end-of-options marker', () => {
    expect(versionRequest('grep', specFor('grep'), ['--', '--version'])).toBeNull()
  })

  it('is null for an unregistered command', () => {
    expect(versionRequest('nope', null, ['--version'])).toBeNull()
  })

  it('is null when the command declares its own --version', () => {
    const own = new CommandSpec({ options: [new Option({ long: '--version' })] })
    expect(versionRequest('custom', specFor('custom', own), ['--version'])).toBeNull()
  })

  // This runs ahead of the parser, and the parser expands an abbreviation, so
  // the two have to agree on what named the option: a line that spans mounts
  // never reaches the enriched spec (it parses against the shared BUILTIN_SPECS
  // entry, which carries no --version), so an exact-match-only check answered
  // `cat --vers /ram/a` and refused `cat --vers /ram/a /disk/b`.
  it('matches an unambiguous abbreviation', () => {
    for (const word of ['--vers', '--versio', '--v']) {
      const out = versionRequest('tsort', specFor('tsort'), [word, '/data/a.txt'])
      expect(decode(out)).toMatch(/^tsort \(Mirage\)/)
    }
  })

  // A value is the parser's to refuse, in getopt_long's own words
  // (`option '--version' doesn't allow an argument`), and an abbreviation
  // naming two options is not this option at all.
  it('is null for an abbreviation carrying a value or naming two options', () => {
    expect(versionRequest('tsort', specFor('tsort'), ['--versio=x'])).toBeNull()
    expect(versionRequest('tsort', specFor('tsort'), ['--version=x'])).toBeNull()
    const two = new CommandSpec({ options: [new Option({ long: '--verbose' })] })
    expect(versionRequest('custom', specFor('custom', two), ['--ver'])).toBeNull()
  })

  // expr reads a long option only when it is the whole line, and only for
  // expr's own grammar: a registered command that borrowed the name answers
  // wherever the word sits, like every other command.
  it('holds the sole-argument window for the builtin alone', () => {
    expect(versionRequest('expr', builtinSpec('expr'), ['--versio'])).not.toBeNull()
    expect(versionRequest('expr', builtinSpec('expr'), ['--version', 'x'])).toBeNull()
    const borrowed = specFor('expr', new CommandSpec({ rest: new Operand({ type: 'str' }) }))
    expect(versionRequest('expr', borrowed, ['--version', 'x'])).not.toBeNull()
  })

  // `--version` is an option like any other, so an option error the scan meets
  // FIRST is what GNU reports: measured on coreutils 9.7, `cat --bogus --vers`
  // is `cat: unrecognized option '--bogus'` (exit 1) and `sort --bogus
  // --version` is sort's own (exit 2).
  it('lets a refusal the scan meets first outrank the version', () => {
    for (const name of ['cat', 'sort', 'tee']) {
      expect(versionRequest(name, builtinSpec(name), ['--bogus', '--vers'])).toBeNull()
      expect(versionRequest(name, builtinSpec(name), ['--bogus', '--version'])).toBeNull()
    }
  })

  // The mirror: coreutils answers INSIDE the getopt loop, calling `version_etc`
  // and exiting there, so a word the scan never reaches cannot outrank it
  // (`cat --version --bogus` prints the version and exits 0 on 9.7).
  it('does not let a refusal the scan never reaches outrank it', () => {
    expect(versionRequest('cat', builtinSpec('cat'), ['--version', '--bogus'])).not.toBeNull()
    expect(versionRequest('cat', builtinSpec('cat'), ['--vers', '--bogus'])).not.toBeNull()
  })

  // grep sets `show_version` and keeps scanning, printing after the loop, so a
  // refusal anywhere outranks the answer; ripgrep's clap parse is whole-line
  // for the same reason. Measured on grep 3.11 and ripgrep 14.1.1: both
  // `--version --bogus` lines exit 2.
  it('makes the deferred family read the whole line', () => {
    for (const name of ['grep', 'rg']) {
      expect(versionRequest(name, builtinSpec(name), ['--version'])).not.toBeNull()
      expect(versionRequest(name, builtinSpec(name), ['--version', '--bogus'])).toBeNull()
      expect(versionRequest(name, builtinSpec(name), ['--bogus', '--version'])).toBeNull()
    }
  })

  // zgrep is a shell script whose own loop answers before it ever builds a grep
  // command, so no refusal outranks it (measured on gzip 1.13: `zgrep --bogus
  // --version f.gz` prints the version, exit 0, where `zgrep --bogus f.gz`
  // reaches grep and exits 2).
  it('lets zgrep answer ahead of every refusal', () => {
    expect(versionRequest('zgrep', builtinSpec('zgrep'), ['--bogus', '--version'])).not.toBeNull()
  })

  // A value-taking option swallows the word, so it is that option's value and
  // never an option at all: `grep -e --version f` greps for the pattern
  // `--version` and exits 1 on grep 3.11.
  it('lets a value-taking option swallow the word', () => {
    expect(versionRequest('grep', builtinSpec('grep'), ['-e', '--version'])).toBeNull()
    expect(versionRequest('grep', builtinSpec('grep'), ['--include', '--version'])).toBeNull()
  })

  // A declared remainder slot is argparse's REMAINDER: the first operand ends
  // option parsing, so every word after it belongs to the program being run
  // rather than to mirage. Verified against argparse itself --
  // `add_argument("--version", action="store_true")` plus
  // `add_argument("rest", nargs=REMAINDER)` answers `["operand", "--version"]`
  // with `version=False` and the flag in `rest`. mirage's parser already
  // agreed; only this scan did not, so `mytool operand --version` printed
  // mirage's version and the handler never ran. Mirrors test_config.py.
  it('keeps the words after a remainder operand', () => {
    const rest = specFor(
      'mytool',
      new CommandSpec({ rest: new Operand({ type: 'str', remainder: true }) }),
    )
    expect(versionRequest('mytool', rest, ['operand', '--version'])).toBeNull()
    expect(versionRequest('mytool', rest, ['operand', '--vers'])).toBeNull()
    // Ahead of the first operand it is still an option, as argparse answers
    // `["--version", "operand"]` with version=true.
    expect(versionRequest('mytool', rest, ['--version', 'operand'])).not.toBeNull()
    expect(versionRequest('mytool', rest, ['--version'])).not.toBeNull()
  })

  // The four builtin specs that declare a remainder (python, python3, node,
  // js) all declare their own --version too, so none of them ever reaches the
  // scan: the wrapper injects nothing and this declines on the first line.
  // Pinned so a spec losing its own --version cannot quietly hand its
  // program's argv to mirage. Mirrors test_config.py.
  it('never reaches the scan for the builtin remainder specs', () => {
    for (const name of ['python', 'python3', 'node', 'js']) {
      const spec = builtinSpec(name)
      expect(hasInjectedVersion(spec)).toBe(false)
      expect(versionRequest(name, spec, ['-c', 'code', '--vers'])).toBeNull()
    }
  })

  // Both tables name one real program, so both are gated on the spec being that
  // program's own grammar. A mount may register a command under a builtin's
  // name, and neither gnulib's deferral nor zgrep's precedence is a fact about
  // that command.
  it('does not let a borrowed name borrow the family', () => {
    for (const name of ['grep', 'zgrep']) {
      const borrowed = specFor(name, new CommandSpec({ rest: new Operand({ type: 'str' }) }))
      expect(versionRequest(name, borrowed, ['--version', '--bogus'])).not.toBeNull()
      expect(versionRequest(name, borrowed, ['--bogus', '--version'])).toBeNull()
    }
  })
})
