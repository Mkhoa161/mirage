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
// First, only `wire/route.ts` may read through here. `loadState` and
// `saveState` stay pure functions of the rows, so the seed path still reads
// the file: `afterSeed` loads a tenant the kit has just cleared and reseeded
// through the client directly, and answering THAT from a cached world would
// hand the reset back the world it was in the middle of replacing. The module
// lives in `store/` because what it holds is store state, keyed by the store's
// own client; what it must never become is a layer inside `loadState`.
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
  // Bumped whenever the authoritative world changes identity -- a drop, or a
  // write installing what it just flushed. `withState` refuses to install a
  // world it began reading under an older generation, and that refusal is the
  // whole reason filling a miss is safe.
  //
  // A READ does not join the run's write queue -- `Router.run` chains it off
  // whatever was queued when it started and lets it run alongside a later
  // write or reset -- so a read that misses can still be inside `loadState`,
  // which is 25 independent queries, when the world underneath it changes.
  // Two ways that bites, and the generation closes both:
  //
  //   - a /reset clears the tenant, reseeds it and drops this entry. Without
  //     the check the read would reinstall the world it had read BEFORE the
  //     reset, into the cache the reset had just emptied.
  //   - a write MISSES at the same moment, loads its own copy, mutates it and
  //     flushes it. Without the check the read's later install would replace
  //     the flushed world with one that predates it -- and because the next
  //     write flushes whatever is cached, that write's rows would then be
  //     erased from SQLite as well. This is why a write installs what it
  //     flushed rather than leaving the entry alone.
  //
  // In both cases the request itself still answers from its own snapshot,
  // which is what every request did before this cache existed. What must not
  // happen is that snapshot OUTLIVING the request.
  generation: number
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
    row = { world: undefined, generation: 0 }
    live.set(tenant, row)
  }
  return row
}

// The world for this request, read from the rows only on a miss.
//
// Inverted rather than a `get` / `load` / `put` the caller sequences itself,
// because the ordering IS the guard: the generation has to be read before the
// load and compared after it, and a caller that read it afterwards would
// compile, typecheck and silently reinstall a stale world. Holding `row`
// across the await is safe because `entry` hands back a stable object that
// every writer mutates in place.
export async function withState(
  db: C,
  tenant: string,
  load: () => Promise<GwsState>,
): Promise<GwsState> {
  const row = entry(db, tenant)
  if (row.world !== undefined) return row.world
  const began = row.generation
  const world = await load()
  if (row.generation === began) row.world = world
  return world
}

// What a write just wrote. Unconditional, and it BUMPS: the rows now say what
// this world says, so any load still in flight is reading an older world and
// must not be allowed to land on top of it.
export function installFlushed(db: C, tenant: string, st: GwsState): void {
  const row = entry(db, tenant)
  row.world = st
  row.generation += 1
}

// Creates the entry when there is none, rather than the cheaper
// `WORLDS.get(db)?.get(tenant)?`. That looks like dead weight and is not: a
// drop on a tenant nothing has cached yet still has to advance the
// generation, or a load already in flight on that tenant compares 0 against 0
// and installs the world it read before this drop.
export function dropState(db: C, tenant: string): void {
  const row = entry(db, tenant)
  row.world = undefined
  row.generation += 1
}

export function dropTenants(db: C, tenants: readonly string[]): void {
  for (const tenant of tenants) dropState(db, tenant)
}

// For the selftest, which has to see what a request would be handed without
// making a request. No route reads this.
export function cachedState(db: C, tenant: string): GwsState | undefined {
  return WORLDS.get(db)?.get(tenant)?.world
}
