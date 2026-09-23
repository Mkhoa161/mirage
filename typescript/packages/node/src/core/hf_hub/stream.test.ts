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

import { runWithRecording } from '@struktoai/mirage-core/observe/context'
import { PathSpec } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HfHubAccessor } from '../../accessor/hf_hub.ts'
import * as client from './client.ts'
import { stream } from './stream.ts'
import { parseEntry } from './tree.ts'

function loaded(): HfHubAccessor {
  const accessor = new HfHubAccessor({ repoId: 'acme/widget' } as never)
  accessor.tree = new Map([
    ['m', parseEntry({ type: 'directory', oid: 'tree-m', size: 0, path: 'm' })],
    ['m/k.txt', parseEntry({ type: 'file', oid: 'oid-k', size: 5, path: 'm/k.txt' })],
  ])
  accessor.treeLoaded = true
  accessor.rowsCache = null
  return accessor
}

const PATH = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })

afterEach(() => {
  vi.restoreAllMocks()
})

// A key named like its mount: neither `m/k.txt` nor `/m/k.txt` is virtual.
describe('hf_hub stream record path', () => {
  it('records the virtual path', async () => {
    vi.spyOn(client, 'hubStream').mockImplementation(async function* () {
      await Promise.resolve()
      yield new TextEncoder().encode('hello')
    })
    const [text, records] = await runWithRecording(async () => {
      let out = ''
      for await (const chunk of stream(loaded(), PATH)) out += new TextDecoder().decode(chunk)
      return out
    })
    expect(text).toBe('hello')
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})
