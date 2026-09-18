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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { ConsistencyPolicy, MountMode } from '@struktoai/mirage-core/types'
import { DiskVFS } from '../vfs/disk/disk.ts'
import { Workspace } from '../workspace.ts'

const DEC = new TextDecoder()

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('fingerprint spike (ConsistencyPolicy port of test_fingerprint_spike.py)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mirage-fp-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('Disk + ALWAYS refetches after external mtime change', async () => {
    writeFileSync(join(root, 'file.txt'), 'v1')
    const vfs = new DiskVFS({ root })
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })
    ws.registry.setConsistency(ConsistencyPolicy.ALWAYS)

    const io1 = await ws.execute('cat /data/file.txt')
    const first = DEC.decode(io1.stdout)
    await sleep(1100)
    writeFileSync(join(root, 'file.txt'), 'v2')
    const io2 = await ws.execute('cat /data/file.txt')
    const second = DEC.decode(io2.stdout)

    expect(first).toBe('v1')
    expect(second).toBe('v2')
    await ws.close()
  })

  it('Disk + LAZY may serve stale cache (no crash guaranteed)', async () => {
    writeFileSync(join(root, 'file.txt'), 'v1')
    const vfs = new DiskVFS({ root })
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })
    ws.registry.setConsistency(ConsistencyPolicy.LAZY)

    const io1 = await ws.execute('cat /data/file.txt')
    const first = DEC.decode(io1.stdout)
    await sleep(1100)
    writeFileSync(join(root, 'file.txt'), 'v2')
    const io2 = await ws.execute('cat /data/file.txt')
    const second = DEC.decode(io2.stdout)

    expect(first).toBe('v1')
    expect(['v1', 'v2']).toContain(second)
    await ws.close()
  })

  it('RAM + ALWAYS falls back gracefully when fingerprint absent', async () => {
    const vfs = new RAMVFS()
    vfs.store.files.set('/file.txt', new TextEncoder().encode('v1'))
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE })
    ws.registry.setConsistency(ConsistencyPolicy.ALWAYS)

    const io1 = await ws.execute('cat /data/file.txt')
    expect(DEC.decode(io1.stdout)).toBe('v1')
    await ws.close()
  })
})
