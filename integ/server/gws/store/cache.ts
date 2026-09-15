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
// across the five core-facet gws targets: 19,240 requests, 125s of loadState,
// against 1.0s of actual handler work. The rows only change under a request
// this process served, so the world it just wrote is the world the next one
// would read back.
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
interface Cached {
  world: GwsState | undefined
  // Every drop bumps this, and `putState` refuses a world whose token is no
  // longer current. That is not belt-and-braces, it is the whole reason a
  // miss is safe to fill.
  //
  // A READ does not join the run's write queue -- `Router.run` chains it off
  // whatever was queued when it started and lets it run alongside a later
  // write. So a read that misses can be inside `loadState`, which is 25
  // independent queries, when a /reset clears the tenant, reseeds it and drops
  // this entry. Without the token that read would then hand `putState` the
  // world it read BEFORE the reset, reinstalling it into the cache the reset
  // had just emptied, and every later request would serve a pre-reset world
  // that no flush ever wrote. The request itself still answers from its own
  // snapshot, which is what it did before this cache existed; what must not
  // happen is that snapshot OUTLIVING the request.
  token: number
}

const WORLDS = new WeakMap<C, Map<string, Cached>>()

function entry(db: C, tenant: string): Cached {
  let live = WORLDS.get(db)
  if (live === undefined) {
    live = new Map()
    WORLDS.set(db, live)
  }
  let row = live.get(tenant)
  if (row === undefined) {
    row = { world: undefined, token: 0 }
    live.set(tenant, row)
  }
  return row
}

export function cachedState(db: C, tenant: string): GwsState | undefined {
  return WORLDS.get(db)?.get(tenant)?.world
}

// Taken BEFORE the load it will be handed back with, never after.
export function loadToken(db: C, tenant: string): number {
  return entry(db, tenant).token
}

export function putState(db: C, tenant: string, st: GwsState, token: number): void {
  const row = entry(db, tenant)
  if (row.token !== token) return
  row.world = st
}

export function dropState(db: C, tenant: string): void {
  const row = entry(db, tenant)
  row.world = undefined
  row.token += 1
}

export function dropTenants(db: C, tenants: readonly string[]): void {
  for (const tenant of tenants) dropState(db, tenant)
}
