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

import { IOResult } from '../../io/types.ts'
import { cliSpecFor, registerCliSpec, unregisterCliSpec } from './specs.ts'
import { CLISpec } from './types.ts'

// Mirrors python/tests/commands/cli/test_specs.py.

function noop(): [null, IOResult] {
  return [null, new IOResult()]
}

const BUNDLED = ['discord', 'gh', 'git', 'gws', 'linear', 'ntn', 'slack']

function writeLeaves(spec: CLISpec): CLISpec[] {
  if (spec.fn !== null) return spec.write ? [spec] : []
  return spec.subcommands.flatMap(writeLeaves)
}

function tree(name: string): CLISpec {
  return new CLISpec({ name, subcommands: [new CLISpec({ name: 'run', fn: noop })] })
}

describe('cli spec registry', () => {
  it('registers, resolves, and unregisters', () => {
    const spec = tree('spectest')
    registerCliSpec(spec)
    try {
      expect(cliSpecFor('spectest')).toBe(spec)
    } finally {
      unregisterCliSpec('spectest')
    }
    expect(() => cliSpecFor('spectest')).toThrow(/unknown cli 'spectest'/)
  })

  it('refuses duplicate registration', () => {
    registerCliSpec(tree('spectest2'))
    try {
      expect(() => {
        registerCliSpec(tree('spectest2'))
      }).toThrow(/already registered/)
    } finally {
      unregisterCliSpec('spectest2')
    }
  })

  it('unregistering an unknown name throws', () => {
    expect(() => {
      unregisterCliSpec('spectest3')
    }).toThrow(/not registered/)
  })

  it('an unknown key names the known specs', () => {
    expect(() => cliSpecFor('spectest4')).toThrow(/known: /)
  })

  // This file imports the registry and nothing else, so the seven resolve
  // only because specs.ts seeds them. Back when each builtin registered
  // itself, a caller saw only the CLIs whose modules something had
  // already imported -- which the old barrel hid by importing them all.
  it('resolves the bundled CLIs without importing their modules', () => {
    for (const name of BUNDLED) {
      expect(cliSpecFor(name).name).toBe(name)
    }
  })

  // A write verb mutates its service by id, so `serves` is the only fact the
  // workspace has about which mounts to expire afterwards. Five bundled CLIs
  // shipped without it, and a message himalaya filed stayed invisible to the
  // mounted account until the index TTL ran out. Runtime packages assert
  // theirs beside their own trees (himalaya, hf).
  it('an account CLI with write verbs names the mounts it serves', () => {
    for (const name of BUNDLED) {
      const spec = cliSpecFor(name)
      if (spec.configModel === null || writeLeaves(spec).length === 0) continue
      expect(spec.serves, `cli '${name}' has write verbs but serves no mount`).not.toHaveLength(0)
    }
  })
})
