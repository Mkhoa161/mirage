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

import type { Ops } from '../../ops/ops.ts'
import type { ProvisionResult } from '../../provision/types.ts'
import type { Session } from '../session/session.ts'
import type { ExecuteOptions, ExecuteResult } from './types.ts'
import type { Workspace } from './workspace.ts'

/** `ExecuteOptions` with the session fixed by the handle. */
export type SessionExecuteOptions = Omit<ExecuteOptions, 'sessionId'>

/**
 * One session's two doors, bound together.
 *
 * `execute` runs a line as the session and `fs` is the op facade run
 * as it, so a host holds one object per agent and both doors answer
 * under the same profile: hides, mount modes, grants and standing
 * decisions. Nothing is stored here; the session record stays with the
 * session manager and `state` reads it. Obtained from
 * `Workspace.session`, which creates the session or adopts it.
 */
export class SessionHandle {
  private readonly ws: Workspace
  readonly sessionId: string

  constructor(ws: Workspace, sessionId: string) {
    this.ws = ws
    this.sessionId = sessionId
  }

  /** The session record: cwd, env, modes, hides, decisions. */
  get state(): Session {
    return this.ws.getSession(this.sessionId)
  }

  /** The op facade run as this session. */
  get fs(): Ops {
    return this.ws.fs.forSession(this.sessionId)
  }

  /** Run a shell line as this session; `Workspace.execute` with the session fixed. */
  execute(
    command: string,
    options?: SessionExecuteOptions & { provision?: false | undefined },
  ): Promise<ExecuteResult>
  execute(
    command: string,
    options: SessionExecuteOptions & { provision: true },
  ): Promise<ProvisionResult>
  execute(
    command: string,
    options: SessionExecuteOptions = {},
  ): Promise<ExecuteResult | ProvisionResult> {
    return this.ws.execute(command, { ...options, sessionId: this.sessionId })
  }
}
