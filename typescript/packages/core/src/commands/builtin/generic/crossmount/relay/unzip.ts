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

import { specOf } from '../../../../spec/builtins.ts'
import { FlagView } from '../../../../spec/flag_view.ts'
import type { PathSpec } from '../../../../../types.ts'
import { IOResult } from '../../../../../io/types.ts'
import { unzipGeneric } from '../../unzip.ts'
import { crossOpts, statOp, streamOp } from '../utils.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'

/**
 * Run an unzip whose archive and -d destination span mounts.
 *
 * Pure wiring: the shared generic runs on dispatch-relayed doors, so
 * the archive is read from its mount and every extracted path lands on
 * whichever mount owns it.
 */
export async function runUnzip(
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
): Promise<CrossResult> {
  const fl = new FlagView(flagKwargs, specOf('unzip'))
  // Scopes arrive in line order and include the -d flag's value, so the
  // archive is the first scope that is not the destination.
  const dest = fl.asStr('d')
  const operands = scopes.filter((s) => s.virtual !== dest)
  const result = await unzipGeneric(
    operands.length > 0 ? operands : scopes,
    textArgs,
    crossOpts(flagKwargs),
    streamOp(dispatch),
    async (p, data) => {
      await dispatch('write', p, [data])
    },
    async (p) => {
      await dispatch('mkdir', p)
    },
    statOp(dispatch),
    true,
  )
  return result ?? [null, new IOResult()]
}
