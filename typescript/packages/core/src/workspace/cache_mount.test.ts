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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { cachesReads } from '../vfs/base.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { createShellParser } from '../shell/parse/index.ts'
import { DEFAULT_READ_TTL, MountMode, PathSpec, ReadPolicy } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

describe('cache is a hidden store, not a mount', () => {
  it('is decoupled from the root mount', async () => {
    // The file cache is reached via `registry.fileCache`, not the root mount's
    // VFS. When no `/` is mounted the root is an ordinary empty RAM mount
    // at `/` (a normal entry in allMounts) and never holds the cache.
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      expect(ws.registry.fileCache).toBe(ws.cache)
      const root = ws.registry.rootMount
      expect(root).not.toBeNull()
      expect(root?.vfs).not.toBe(ws.cache)
      expect(cachesReads(root?.vfs ?? new RAMVFS())).toBe(false)
      expect(root?.prefix).toBe('/')
      expect(ws.registry.allMounts()).toContain(root)
    } finally {
      await ws.close()
    }
  })

  it('reuses a user-provided / mount as the root anchor (no synthetic root)', async () => {
    const userRoot = new RAMVFS()
    const ws = new Workspace({ '/': userRoot }, { mode: MountMode.WRITE })
    try {
      expect(ws.registry.rootMount?.vfs).toBe(userRoot)
      expect(ws.registry.fileCache).toBe(ws.cache)
    } finally {
      await ws.close()
    }
  })
})

describe('warm read serves from the hidden store, command stays on its mount', () => {
  it('serves a cached operand under LAZY after out-of-band mutation', async () => {
    const ram = new RAMVFS()
    // Force the cache on a local backend so the read is cached and, under LAZY,
    // never revalidated. A subsequent out-of-band mutation must NOT be seen:
    // the warm read serves the cached bytes from the hidden store while the
    // command stays on its real mount.
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      { '/r': ram },
      {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.BOUNDED, ttl: DEFAULT_READ_TTL },
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      const first = DEC.decode((await ws.shell('cat /r/a.txt')).stdout)
      expect(first).toContain('v1')
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v2\n'))
      const second = DEC.decode((await ws.shell('cat /r/a.txt')).stdout)
      expect(second).toContain('v1')
      expect(second).not.toContain('v2')
    } finally {
      await ws.close()
    }
  })
})

describe('the mount bound reaches the cache through a shell read', () => {
  it('stamps a per-mount ttl on the entry a cold read fills', async () => {
    const ram = new RAMVFS()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      { '/r': ram },
      {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.BOUNDED, ttl: 45 },
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      await ws.shell('cat /r/a.txt')
      const store = ws.cache as unknown as {
        snapshotEntries(): { key: string; entry: { ttl: number | null } }[]
      }
      // The value the mount declared, not merely "some bound". A stamp
      // that hardcoded the default would leave `isUnbounded` false and
      // make a per-mount `ttl:` cosmetic.
      expect(store.snapshotEntries().find((e) => e.key === '/r/a.txt')?.entry.ttl).toBe(45)
    } finally {
      await ws.close()
    }
  })

  // The self-heal, end to end: an entry written before the bound existed
  // is dropped on the next read and refilled with one. Only refusing to
  // serve it would refetch forever without ever stamping.
  it('drops and re-stamps a bound-less entry on the next read', async () => {
    const ram = new RAMVFS()
    ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
    const ws = new Workspace(
      { '/r': ram },
      {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.BOUNDED, ttl: 45 },
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
      // The same bytes the backend holds: that is what an entry written
      // before bounds existed looks like, and it is the case where a
      // refusal alone cannot heal, because the refill short-circuits on
      // equal bytes rather than re-setting.
      await ws.cache.set('/r/a.txt', ENC.encode('v1\n'))
      expect(await ws.cache.isUnbounded('/r/a.txt')).toBe(true)

      expect(DEC.decode((await ws.shell('cat /r/a.txt')).stdout)).toContain('v1')
      expect(await ws.cache.isUnbounded('/r/a.txt')).toBe(false)
    } finally {
      await ws.close()
    }
  })
})

describe('namespace orphan GC on remote delete', () => {
  it('GCs an orphaned overlay when a stat reports the path gone under fresh', async () => {
    // The subject is the reaction, not RAM: the instance declares the two
    // capabilities the verdict asks for so a RAM mount can legally carry
    // the policy.
    const ram = new RAMVFS()
    Object.assign(ram, { cachesReads: true, readRevalidatable: true })
    const ws = new Workspace(
      { '/data': ram },
      { mode: MountMode.WRITE, read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL } },
    )
    try {
      await ws.namespace.ensureLoaded()
      await ws.namespace.setAttrs('/data/gone.txt', { mode: 0o600 })
      expect(ws.namespace.metaFor('/data/gone.txt')).not.toBeNull()
      await expect(ws.dispatch('stat', '/data/gone.txt')).rejects.toThrow()
      expect(ws.namespace.metaFor('/data/gone.txt')).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('a single-mount shell stat GCs an orphaned overlay under fresh', async () => {
    const ram = new RAMVFS()
    Object.assign(ram, { cachesReads: true, readRevalidatable: true })
    const ws = new Workspace(
      { '/r': ram },
      {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL },
        shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
      },
    )
    try {
      await ws.namespace.ensureLoaded()
      await ws.namespace.setAttrs('/r/gone.txt', { mode: 0o600 })
      expect(ws.namespace.metaFor('/r/gone.txt')).not.toBeNull()
      await ws.shell('stat /r/gone.txt')
      expect(ws.namespace.metaFor('/r/gone.txt')).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('leaves the overlay in place under LAZY', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, read: { policy: ReadPolicy.BOUNDED, ttl: DEFAULT_READ_TTL } },
    )
    try {
      await ws.namespace.ensureLoaded()
      await ws.namespace.setAttrs('/data/gone.txt', { mode: 0o600 })
      await expect(ws.dispatch('stat', '/data/gone.txt')).rejects.toThrow()
      expect(ws.namespace.metaFor('/data/gone.txt')).not.toBeNull()
    } finally {
      await ws.close()
    }
  })
})
