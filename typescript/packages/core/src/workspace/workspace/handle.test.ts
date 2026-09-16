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

import { afterEach, describe, expect, it } from 'vitest'
import { runWithSession } from '../../context/session_context.ts'
import { parseSessionProfile } from '../../policy/profile.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { SessionHandle } from './handle.ts'
import { Workspace } from './workspace.ts'

const open: Workspace[] = []

afterEach(async () => {
  for (const ws of open.splice(0)) await ws.close()
})

async function seeded(): Promise<Workspace> {
  const parser = await getTestParser()
  const ws = new Workspace(
    { '/repo': [new RAMResource(), MountMode.WRITE] as const },
    {
      mode: MountMode.WRITE,
      shellParser: parser,
      profiles: { reviewer: parseSessionProfile({ paths: { hide: ['/repo/secrets'] } }) },
    },
  )
  open.push(ws)
  await ws.execute(
    'mkdir -p /repo/secrets && echo hello > /repo/README.md && echo PRIVATE > /repo/secrets/key.pem',
  )
  return ws
}

describe('SessionHandle', () => {
  it('binds both doors to one session', async () => {
    // One object per agent: the shell door and the op door answer
    // under the same profile, so a hide the shell honors is a hide the
    // file tool honors too.
    const ws = await seeded()
    const reviewer = ws.session('reviewer', { profile: 'reviewer' })
    expect(reviewer).toBeInstanceOf(SessionHandle)
    expect(reviewer.sessionId).toBe('reviewer')
    expect(reviewer.state).toBe(ws.getSession('reviewer'))
    expect(stdoutStr(await reviewer.execute('cat /repo/README.md'))).toBe('hello\n')
    expect((await reviewer.execute('cat /repo/secrets/key.pem')).exitCode).toBe(1)
    expect(await reviewer.fs.readFileText('/repo/README.md')).toBe('hello\n')
    await expect(reviewer.fs.readFile('/repo/secrets/key.pem')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await ws.fs.readFileText('/repo/secrets/key.pem')).toBe('PRIVATE\n')
    expect(reviewer.fs.records).toBe(ws.fs.records)
  })

  it('adopts an existing session and refuses a profile for it', async () => {
    const ws = await seeded()
    const first = ws.session('reviewer', { profile: 'reviewer' })
    const again = ws.session('reviewer')
    expect(again.state).toBe(first.state)
    expect(() => ws.session('reviewer', { profile: 'reviewer' })).toThrow(/exists/)
    expect(() => ws.session('reviewer', { mounts: { '/repo': 'read' } })).toThrow(/exists/)
  })

  it('forwards per-call options and keeps a bound session', async () => {
    const ws = await seeded()
    const reviewer = ws.session('reviewer', { profile: 'reviewer' })
    expect(stdoutStr(await reviewer.execute('pwd', { cwd: '/repo' }))).toBe('/repo\n')
    expect(reviewer.state.cwd).not.toBe('/repo')
    const plan = await reviewer.execute('cat /repo/README.md', { provision: true })
    expect(plan).toBeDefined()
    await runWithSession(ws.getSession(ws.defaultSessionId), async () => {
      // A session already bound is kept by the op door, so a handle
      // reached from inside the default session's own command reads
      // as that session, never wider.
      expect(await reviewer.fs.readFileText('/repo/secrets/key.pem')).toBe('PRIVATE\n')
    })
  })
})
