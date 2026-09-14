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

import type { C } from './client.ts'
import type { GwsState } from './state.ts'

// One tenant's loaded world, kept between requests.
//
// `loadState` reads 25 tables to rebuild a world that the PREVIOUS request
// already had in hand, and every request paid for it, reads included. Measured
// on the gdrive target: 9,593 requests, 98.5 s of loadState, against 0.73 s of
// actual handler work. The rows only change under a request this process
// served, so the world it just wrote is the world the next one would read
// back.
//
// TWO BOUNDARIES MAKE THIS SAFE, AND BOTH ARE LOAD-BEARING.
//
// First, the cache is the ROUTE boundary's, not the store's. `loadState` and
// `saveState` stay pure functions of the rows, so the seed path still reads
// the file: `afterSeed` loads a tenant the kit has just cleared and reseeded
// through the client directly, and answering THAT from a cached world would
// hand the reset back the world it was in the middle of replacing. Only
// `stateful` reads through here. Do not move this into `loadState`.
//
// Second, the key is the run's CLIENT, not its name. A world belongs to one
// SQLite file, and the client is that file's identity in this process: a run
// whose client is closed or recreated (`pool.close`, `pool.recreate`,
// `pool.dispose`) loses its world with no eviction hook of its own, and two
// Runtimes in one process -- the launcher, an in-process `start()` -- cannot
// reach each other's worlds even when they name the same run and tenant, which
// a module-level map keyed by `run|tenant` would let them do. There is also no
// key separator to get wrong.
//
// The one thing that changes a tenant's rows from outside a route is /reset,
// which is why gws declares `afterReset` and this module exports `dropTenants`.
const WORLDS = new WeakMap<C, Map<string, GwsState>>()

export function cachedState(db: C, tenant: string): GwsState | undefined {
  return WORLDS.get(db)?.get(tenant)
}

export function putState(db: C, tenant: string, st: GwsState): void {
  const live = WORLDS.get(db)
  if (live !== undefined) {
    live.set(tenant, st)
    return
  }
  WORLDS.set(db, new Map([[tenant, st]]))
}

export function dropState(db: C, tenant: string): void {
  WORLDS.get(db)?.delete(tenant)
}

export function dropTenants(db: C, tenants: readonly string[]): void {
  const live = WORLDS.get(db)
  if (live === undefined) return
  for (const tenant of tenants) live.delete(tenant)
}
