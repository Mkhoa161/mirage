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

import { Prisma } from '../../../generated/gws/index.js'
import { RouteError } from '../../kit/typescript/index.ts'
import type { Ctx, Dmmf, KitHandler, KitRoute, Reply } from '../../kit/typescript/index.ts'
import { cachedState, dropState, loadToken, putState } from '../store/cache.ts'
import type { C } from '../store/client.ts'
import { loadState } from '../store/load.ts'
import { saveState } from '../store/save.ts'
import type { GwsState } from '../store/state.ts'

// gws's own path compiler, because the kit's differs from the regexes this
// fake is a port of in two ways that are both observable.
//
// 1. The kit compiles `^...\/?$`, so every route also answers with a trailing
//    slash: `GET /drive/v3/files/` returned the whole file list where the old
//    regex (a bare `$`) answered `Unknown route`. A fake that answers a URL
//    the real API does not is a fake that hides a client bug.
// 2. Every kit parameter is `([^/]+)`, where the old fake used two classes on
//    purpose. A resource id was `[^/:]+` so that a path holding an in-segment
//    verb could never be read as an id, and only the segments that really can
//    hold a colon (an A1 range, a `<id>:batchUpdate` target) were wider. A
//    Sheets range was wider still, `(.+)`, because the range is the rest of
//    the path.
//
// So a route names the class per parameter and the default is the kit's.
export type ParamClass = 'id' | 'seg' | 'rest'

const CLASSES: Record<ParamClass, string> = {
  id: '([^/:]+)',
  seg: '([^/]+)',
  rest: '(.+)',
}

const PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g
const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g

const DMMF = Prisma.dmmf as unknown as Dmmf

export interface RouteOpts {
  write?: boolean
  classes?: Record<string, ParamClass>
}

// The store boundary, and the only place it exists. A handler is written
// against GwsState -- the whole tenant world in the shapes the renderers read
// -- and this is what turns one into a Prisma request: take the world, call,
// and on a write route flush after. Wrapping in `route()` rather than in each
// handler is what keeps the port from touching 38 call sites, and it means a
// route CANNOT forget the flush, because declaring `write: true` is the same
// act as asking for one.
//
// The world comes from `store/cache.ts` and is only READ from the rows on a
// miss. SQLite stays the authority across everything that is not a request --
// the seed path, the template copy a fresh run is served from, a process that
// starts against an existing file -- but between two requests on one run the
// authority is the object this wrapper is holding, because nothing else can
// have changed the rows. That module states the two boundaries which make it
// safe; the one this file owns is the guard below.
//
// A read is not flushed, so a handler on a read route must not mutate. That is
// true of every route today, and it is checked rather than trusted, because
// the caching makes the consequence worse than it was: a dropped mutation used
// to die with the request, and now it would SURVIVE in a world that never
// reaches the file, so memory and SQLite disagree and the next template copy
// or restart serves a different world. So a mismatch evicts as well as
// complaining, which puts the tenant back on the rows either way.
function stateful(handler: KitHandler<GwsState>, write: boolean): KitHandler<C> {
  return async (ctx: Ctx<C>): Promise<Reply> => {
    let st = cachedState(ctx.db, ctx.tenant)
    if (st === undefined) {
      // The token is taken BEFORE the load, and `putState` drops the world on
      // the floor if an invalidation landed while those 25 queries were in
      // flight. A read does not join the run's write queue, so a /reset can
      // clear, reseed and drop this tenant underneath one; see `Cached.token`.
      const token = loadToken(ctx.db, ctx.tenant)
      st = await loadState(ctx.db, ctx.tenant)
      putState(ctx.db, ctx.tenant, st, token)
    }
    const before = write ? 0 : fingerprint(st)
    try {
      const reply = await handler({ ...ctx, db: st })
      if (write) {
        await saveState(ctx.db, DMMF, ctx.tenant, st)
      } else if (fingerprint(st) !== before) {
        dropState(ctx.db, ctx.tenant)
        process.stderr.write(
          `gws fake: read route advanced the clock or a mint counter and the ` +
            `advance was dropped; mark it write: true\n`,
        )
      }
      return reply
    } catch (err: unknown) {
      // A handler mutates the world in place, so a throw half way through
      // leaves one that is partly applied and was never written. That used to
      // be discarded with the request; now it IS the cache, so it has to be
      // dropped or the next request serves a world no flush ever agreed to.
      dropState(ctx.db, ctx.tenant)
      throw err
    }
  }
}

// Cheap proof that a read route left the world alone.
//
// The clock and the mint counters are here because a handler advances them by
// calling `now()` or `nextId()`, which looks like nothing at the call site:
// the request that advanced the counter still answers with the new id, and
// only the NEXT request finds it handed out twice.
//
// Every map's SIZE rides along too, which the uncached version did not need --
// anything else a read mutated was discarded either way, so the mutation was
// invisible but also harmless. Cached it is neither. A size is O(1) per map
// and catches the shape of mutation a read could plausibly make, an entry
// added or removed. It cannot catch a field edited in place; nothing this
// cheap can, and the corpus is what covers that.
//
// Folded rather than summed, so that a `+1` tick and a `-1` file cannot cancel
// out into a world that looks untouched.
function fingerprint(st: GwsState): number {
  let h = st.ticks
  for (const n of st.counters.values()) h = (h * 31 + n) | 0
  for (const size of [
    st.files.size,
    st.drives.size,
    st.docs.size,
    st.sheets.size,
    st.presentations.size,
    st.messages.size,
    st.labels.size,
    st.calendars.size,
    st.events.size,
    st.forms.size,
    st.counters.size,
  ]) {
    h = (h * 31 + size) | 0
  }
  for (const bucket of st.events.values()) h = (h * 31 + bucket.size) | 0
  return h
}

export function route(
  method: string,
  path: string,
  handler: KitHandler<GwsState>,
  opts: RouteOpts = {},
): KitRoute<C> {
  if (!path.startsWith('/')) throw new RouteError(`route path must start with /: ${path}`)
  const params: string[] = []
  const classes = opts.classes ?? {}
  const body = path.replace(ESCAPE_RE, '\\$&').replace(PARAM_RE, (_all, name: string) => {
    params.push(name)
    return CLASSES[classes[name] ?? 'seg']
  })
  const write = opts.write === true
  return {
    method: method.toUpperCase(),
    path,
    pattern: new RegExp(`^${body}$`),
    params,
    handler: stateful(handler, write),
    write,
  }
}
