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
import { read } from './read.ts'
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

// A key named like its mount: the record must name the virtual path, not the
// mount-relative `/m/k.txt` the prefix guess leaves alone. No mount prefix is
// pushed, so the body holds across the recorder change.
describe('hf_hub read record path', () => {
  it('records the virtual path', async () => {
    vi.spyOn(client, 'hubBytes').mockResolvedValue(new TextEncoder().encode('hello'))
    const [data, records] = await runWithRecording(() => read(loaded(), PATH))
    expect(new TextDecoder().decode(data)).toBe('hello')
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})
