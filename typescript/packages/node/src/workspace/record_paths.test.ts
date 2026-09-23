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

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import type { OpRecord } from '@struktoai/mirage-core/observe/record'
import { MountMode } from '@struktoai/mirage-core/types'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import type { SSHAccessor } from '../accessor/ssh.ts'
import { type FakeSftp, makeFakeAccessor } from '../core/ssh/_test_utils.ts'
import { DiskVFS } from '../vfs/disk/disk.ts'
import { installS3Mock } from '../vfs/s3/mock.ts'
import { S3VFS } from '../vfs/s3/s3.ts'
import { SSHVFS } from '../vfs/ssh/ssh.ts'
import { Workspace } from '../workspace.ts'

// Every record a backend makes must name the operand's virtual path. The key
// is named like its mount (`m/k.txt` under `/m`), the one shape that tells a
// virtual path from a mount-relative one repaired by the recorder's prefix
// guess: the guess turns `/m/k.txt` into itself, not `/m/m/k.txt`. The op
// sequences are measured per backend; every path is the operand's virtual
// path, never a measured value.

const SCRIPT = [
  'echo x > /m/m/k.txt',
  'echo y >> /m/m/k.txt',
  'echo z | tee -a /m/m/k.txt',
  'touch /m/m/new.txt',
  'truncate -s 0 /m/m/new.txt',
  'cat /m/m/k.txt',
  'cp /m/m/k.txt /r/k.txt',
  'cp /m/m/k.txt /m/m/k2.txt',
  'mv /m/m/new.txt /m/m/moved.txt',
  'rm /m/m/moved.txt',
  'mkdir /m/m/e; rmdir /m/m/e',
  'mkdir /m/m/d; touch /m/m/d/f; rm -r /m/m/d',
]

// Namespace ops record against the enclosing frame, not the backend.
const EXEMPT = new Set([
  'setattr',
  'symlink',
  'readlink',
  'getxattr',
  'setxattr',
  'listxattr',
  'removexattr',
])

const K = '/m/m/k.txt'
const NEW = '/m/m/new.txt'
const C = '/m/m/c.txt'

function underM(records: readonly OpRecord[]): [string, string][] {
  return records
    .filter((r) => (r.path === '/m' || r.path.startsWith('/m/')) && !EXEMPT.has(r.op))
    .map((r) => [r.op, r.path])
}

async function ledger(vfs: VFS, setup: string | null): Promise<[string, string][]> {
  const ws = new Workspace({ '/m': vfs, '/r': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    if (setup !== null) expect((await ws.shell(setup)).exitCode).toBe(0)
    const start = ws.records.length
    for (const line of SCRIPT) {
      const io = await ws.shell(line)
      expect(io.exitCode, `${line}: ${new TextDecoder().decode(io.stderr)}`).toBe(0)
    }
    const shell = ws.records.slice(start)
    const [, block] = await runWithRecording(async () => {
      await ws.dispatch('create', C)
      await ws.dispatch('append', C, [new TextEncoder().encode('q')])
    })
    return underM([...shell, ...block])
  } finally {
    await ws.close()
  }
}

const NATIVE_APPEND: [string, string][] = [
  ['write', K],
  ['read', K],
  ['write', K],
  ['append', K],
  ['write', NEW],
  ['truncate', NEW],
  ['read', K],
  ['read', K],
  ['write', '/m/m/d/f'],
]

describe('record paths name the virtual path (node backends)', () => {
  it('ram', async () => {
    expect(await ledger(new RAMVFS(), 'mkdir -p /m/m')).toEqual([
      ...NATIVE_APPEND,
      ['create', C],
      ['append', C],
    ])
  })

  it('disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mirage-record-paths-'))
    mkdirSync(join(root, 'm'))
    try {
      // TS disk create records `write` (python records `create`).
      expect(await ledger(new DiskVFS({ root }), null)).toEqual([
        ...NATIVE_APPEND,
        ['write', C],
        ['append', C],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('s3', async () => {
    const mock = installS3Mock()
    try {
      const vfs = new S3VFS({
        bucket: 'record-paths',
        region: 'us-east-1',
        accessKeyId: 'fake',
        secretAccessKey: 'fake',
        forcePathStyle: true,
      })
      // cat and the cp sources are served from cache; tee -a and the op-door
      // append are a read plus a write, since s3 has no native append.
      expect(await ledger(vfs, null)).toEqual([
        ['write', K],
        ['read', K],
        ['write', K],
        ['read', K],
        ['write', K],
        ['write', NEW],
        ['truncate', NEW],
        ['copy', '/m/m/k2.txt'],
        ['rename', NEW],
        ['rename', '/m/m/moved.txt'],
        ['unlink', '/m/m/moved.txt'],
        ['rmdir', '/m/m/e'],
        ['write', '/m/m/d/f'],
        ['rm_r', '/m/m/d'],
        ['create', C],
        ['read', C],
        ['write', C],
      ])
    } finally {
      mock.restore()
    }
  })

  it('ssh', async () => {
    const state: FakeSftp = {
      files: new Map(),
      dirs: new Map([
        ['/', {}],
        ['/m', {}],
      ]),
    }
    const vfs = new SSHVFS({ host: 'example.com', username: 'alice', password: 'secret' })
    ;(vfs as { accessor: SSHAccessor }).accessor = makeFakeAccessor(state, '/')
    // TS ssh records `write` only (python also records read, create, truncate).
    expect(await ledger(vfs, null)).toEqual([
      ['write', K],
      ['write', K],
      ['write', NEW],
      ['write', NEW],
      ['write', '/m/m/k2.txt'],
      ['write', '/m/m/d/f'],
      ['write', C],
    ])
  })
})
