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

import { IndexEntry } from '@struktoai/mirage-core/cache/index/config'
import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { LookupStatus } from '@struktoai/mirage-core/cache/index/config'
import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { ensureLiveIndex, localRows, refillIndex } from './tree.ts'
import { withIndexLock } from '@struktoai/mirage-core/cache/index/lock'

/**
 * What sits at one mount-absolute key.
 *
 * `entry` is null for a directory the tree implies but has no row of its own
 * for, which is why a caller must read `isDir` and `exists` rather than
 * testing `entry` for truth.
 */
export interface Found {
  entry: IndexEntry | null
  children: string[] | null
}

function exists(found: Found): boolean {
  return found.entry !== null || found.children !== null
}

export function isDir(found: Found): boolean {
  if (found.children !== null) return true
  return found.entry !== null && found.entry.resourceType === 'folder'
}

/**
 * Resolve one mount-absolute key against the mount's listing.
 *
 * The single place the two storage paths are told apart: a workspace mount
 * answers from its seeded index, and a mount built without one answers from
 * tables derived from the accessor's tree. Both are built by `indexRows`, so
 * they cannot disagree.
 */
export async function lookup(
  accessor: HfHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  key: string,
): Promise<Found> {
  if (index === undefined) {
    const { entries, children } = await localRows(accessor, prefix)
    return { entry: entries.get(key) ?? null, children: children.get(key) ?? null }
  }
  return withIndexLock(index, keyOf(prefix, ''), async () => {
    await ensureLiveIndex(accessor, index, prefix)
    let result = await index.get(key)
    let listing = await index.listDir(key)
    const parent =
      key === keyOf(prefix, '')
        ? listing
        : await index.listDir(key.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || '/')
    // The index is the whole listing rather than a cache in front of one, so an
    // *expired* answer means the tree aged out, not that the path is gone.
    // Refetch once and ask again; a miss against a live index is a real absence
    // and must not cost a tree fetch.
    if (parent.status === LookupStatus.EXPIRED || listing.status === LookupStatus.EXPIRED) {
      if (await refillIndex(accessor, index, prefix)) {
        result = await index.get(key)
        listing = await index.listDir(key)
      }
    }
    return { entry: result.entry ?? null, children: listing.entries ?? null }
  })
}

/** The mount-absolute key for a mount-local path. */
export function keyOf(prefix: string, local: string): string {
  const rel = local.replace(/^\/+|\/+$/g, '')
  const stem = prefix.replace(/\/+$/, '')
  if (rel === '') return stem === '' ? '/' : stem
  return stem === '' ? `/${rel}` : `${stem}/${rel}`
}

/** Whether a mount-local path exists as a non-directory. */
export async function probeFile(
  accessor: HfHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  local: string,
): Promise<boolean> {
  const found = await lookup(accessor, index, prefix, keyOf(prefix, local))
  return exists(found) && !isDir(found)
}

/** Whether a mount-local path exists as a directory. */
export async function probeDir(
  accessor: HfHubAccessor,
  index: IndexCacheStore | undefined,
  prefix: string,
  local: string,
): Promise<boolean> {
  return isDir(await lookup(accessor, index, prefix, keyOf(prefix, local)))
}

/** A row for a directory the tree implies but has no row for. */
export function dirStatEntry(key: string): IndexEntry {
  const trimmed = key.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return new IndexEntry({
    id: '',
    name: (cut === -1 ? trimmed : trimmed.slice(cut + 1)) || '/',
    resourceType: 'folder',
  })
}
