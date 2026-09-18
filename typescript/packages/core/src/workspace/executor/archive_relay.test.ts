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
import { writeTar } from '../../commands/builtin/tar_helper.ts'
import { OpsRegistry } from '../../ops/registry.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { gzip } from '../../utils/compress.ts'
import { getTestParser, stderrStr, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

// Direct port of tests/workspace/executor/test_archive_relay.py: member
// selectors stay off routing, extraction lands in the cwd or -C across
// mounts through relay doors, and a create-mode span keeps the refusal.

const ENC = new TextEncoder()

async function tgzBytes(): Promise<Uint8Array> {
  const raw = await writeTar([
    {
      name: './memory/memory.json',
      data: ENC.encode('content:./memory/memory.json\n'),
      isFile: true,
      isDir: false,
      linkname: '',
    },
    {
      name: './other.txt',
      data: ENC.encode('content:./other.txt\n'),
      isFile: true,
      isDir: false,
      linkname: '',
    },
  ])
  return gzip(raw)
}

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const root = new RAMVFS()
  const work = new RAMVFS()
  work.store.files.set('/files.tar.gz', await tgzBytes())
  const registry = new OpsRegistry()
  registry.registerVfs(root)
  registry.registerVfs(work)
  return new Workspace(
    { '/': root, '/work/': work },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

describe('tar member selectors and relay extraction', () => {
  it('a selector does not join routing', async () => {
    const ws = await makeWs()
    const io = await ws.execute('tar -xOzf /work/files.tar.gz ./memory/memory.json')
    expect(stderrStr(io)).toBe('')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('content:./memory/memory.json\n')
  })

  it('a -t selector lists only its subtree', async () => {
    const ws = await makeWs()
    const io = await ws.execute('tar -tzf /work/files.tar.gz ./memory')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('./memory/memory.json\n')
  })

  it('a miss reports Not found in archive and exits 2', async () => {
    const ws = await makeWs()
    const io = await ws.execute('tar -tzf /work/files.tar.gz nope')
    expect(io.exitCode).toBe(2)
    expect(stderrStr(io)).toBe(
      'tar: nope: Not found in archive\n' +
        'tar: Exiting with failure status due to previous errors\n',
    )
  })

  it('extraction lands in the cwd across mounts', async () => {
    const ws = await makeWs()
    const io = await ws.execute('tar -xzf /work/files.tar.gz')
    expect(io.exitCode).toBe(0)
    const cat = await ws.execute('cat /memory/memory.json')
    expect(stdoutStr(cat)).toBe('content:./memory/memory.json\n')
  })

  it('-C extracts into another mount', async () => {
    const ws = await makeWs()
    const io = await ws.execute('tar -xzf /work/files.tar.gz -C /dest')
    expect(stderrStr(io)).toBe('')
    expect(io.exitCode).toBe(0)
    const cat = await ws.execute('cat /dest/other.txt')
    expect(stdoutStr(cat)).toBe('content:./other.txt\n')
  })

  it('a create-mode span keeps the refusal', async () => {
    const ws = await makeWs()
    await ws.execute('mkdir -p /src && echo hi > /src/f.txt')
    const io = await ws.execute('tar -czf /work/backup.tgz /src')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('paths span multiple mounts')
  })
})
