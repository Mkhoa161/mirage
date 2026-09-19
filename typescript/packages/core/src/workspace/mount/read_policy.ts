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

import { DEFAULT_READ_TTL, ReadPolicy, type ReadSpec } from '../../types.ts'
import { cachesReads, readRevalidatable, type VFS } from '../../vfs/base.ts'

/**
 * Coerce a declared read policy and bound into a ReadSpec.
 *
 * Coercion only: an unknown name is refused here, but whether the resolved
 * policy is one this mount's backend can honour is `checkReadCapability`'s
 * question. The two are split the way Python's `fuse/backend.py` splits
 * `resolve_backend` from `require_kernel_backend`, so the config door and the
 * mount door each run exactly one of them and a refusal is computed once.
 *
 * Missing means bounded at the default bound, everywhere: an absent `read:`
 * in YAML, `undefined` here, and the `Mount` options default all resolve to
 * the same thing.
 *
 * @throws if the policy name is not a known one.
 */
export function resolveReadSpec(policy: string | undefined, ttl: number | undefined): ReadSpec {
  let resolved: ReadPolicy = ReadPolicy.BOUNDED
  if (policy !== undefined && policy !== '') {
    const lowered = policy.toLowerCase()
    const known = Object.values(ReadPolicy) as string[]
    if (!known.includes(lowered)) {
      throw new Error(`unknown read policy '${policy}'; expected one of: ${known.join(', ')}`)
    }
    resolved = lowered as ReadPolicy
  }
  return { policy: resolved, ttl: ttl ?? DEFAULT_READ_TTL }
}

/**
 * Refuse a read policy this mount's backend cannot honour.
 *
 * The rules are ordered, and the order is the answer to two questions that
 * collide on a disk mount: whether the gate can fire at all, and whether the
 * token behind it is worth comparing. A backend that does not cache reads is
 * answered by the first and never reaches the second.
 *
 * A policy that cannot act must say so. Degrading `fresh` to `bounded` on a
 * backend that cannot revalidate is the silent downgrade this whole policy
 * exists to remove, so it is a refusal at mount time rather than a warning at
 * read time.
 *
 * @throws if the backend cannot honour the declared policy.
 */
export function checkReadCapability(prefix: string, vfs: VFS, spec: ReadSpec): void {
  if (spec.policy === ReadPolicy.PINNED) {
    throw new Error(
      `mount '${prefix}': read: pinned needs a version layer to pin to, and ` +
        'mirage has none; use fresh or bounded',
    )
  }
  if (spec.policy !== ReadPolicy.FRESH) return
  if (!cachesReads(vfs)) {
    throw new Error(
      `mount '${prefix}': read: fresh needs a resource that caches reads; ` +
        `${vfs.kind} does not, so the freshness check could never run`,
    )
  }
  if (!readRevalidatable(vfs)) {
    throw new Error(
      `mount '${prefix}': read: fresh needs a resource that stamps a ` +
        `comparable content token on reads; ${vfs.kind} does not`,
    )
  }
}
