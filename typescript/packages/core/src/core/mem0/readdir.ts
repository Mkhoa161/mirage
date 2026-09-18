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

import type { Mem0Accessor } from '../../accessor/mem0.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { makeReaddir } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { jsonBytes } from '../render/json.ts'
import { getAllMemories } from './client.ts'
import { detectScope } from './scope.ts'

async function listMemories(
  accessor: Mem0Accessor,
  _match: ScopeMatch,
): Promise<[string, IndexEntry][]> {
  const entries: [string, IndexEntry][] = []
  for (const memory of await getAllMemories(accessor)) {
    const memoryId = String(memory.id)
    const filename = `${memoryId}.json`
    entries.push([
      filename,
      new IndexEntry({
        id: memoryId,
        name: filename,
        resourceType: 'mem0/memory',
        vfsName: filename,
        size: jsonBytes(memory).length,
        remoteTime:
          typeof memory.updated_at === 'string'
            ? memory.updated_at
            : typeof memory.created_at === 'string'
              ? memory.created_at
              : '',
        extra: { memory },
      }),
    ])
  }
  return entries
}

export const readdir = makeReaddir<Mem0Accessor>(detectScope, {
  listers: { root: listMemories },
  leafError: 'enotdir',
})
