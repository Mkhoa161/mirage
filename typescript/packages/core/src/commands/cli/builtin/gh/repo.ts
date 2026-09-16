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

import { FlagView } from '../../../spec/flag_view.ts'
import {
  createRepo,
  forkRepo,
  listRepos,
  login,
  readReadme,
  renameRepo,
  viewRepo,
} from '../../../../core/github/repo.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import { camel, ghRepo, ghTransport, textOut, textValue, typedOut } from './accessor.ts'

export const REPO_FIELDS = [
  'createdAt',
  'defaultBranchRef',
  'description',
  'isFork',
  'isPrivate',
  'name',
  'nameWithOwner',
  'owner',
  'pushedAt',
  'updatedAt',
  'url',
  'visibility',
] as const

function repo(value: unknown): Record<string, unknown> {
  const row = camel(value)
  const result = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
  if ('fullName' in result) {
    result.nameWithOwner = result.fullName
    delete result.fullName
  }
  if ('defaultBranch' in result) {
    result.defaultBranchRef = { name: result.defaultBranch }
    delete result.defaultBranch
  }
  if ('private' in result) {
    result.isPrivate = result.private
    delete result.private
  }
  if ('fork' in result) {
    result.isFork = result.fork
    delete result.fork
  }
  return result
}

/**
 * gh's own text view of a repository: two tab-separated header lines and
 * then the README verbatim, with the `--` separator omitted entirely when
 * there is no README. Probed against gh 2.85, whose description line is
 * present and empty for a repository that has none.
 */
export function summary(repo: unknown, readme: string | null): string {
  const fields = (repo ?? {}) as { full_name?: unknown; description?: unknown }
  const name = typeof fields.full_name === 'string' ? fields.full_name : ''
  const description = typeof fields.description === 'string' ? fields.description : ''
  const head = `name:\t${name}\ndescription:\t${description}\n`
  return readme === null ? head : `${head}--\n${readme}`
}

export async function view(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const transport = ghTransport(inv.config)
  const ref = ghRepo(inv.config, inv.texts[0] ?? fl.asStr('repo'))
  const value = await viewRepo(transport, ref)
  const human =
    fl.asStr('json') === undefined ? summary(value, await readReadme(transport, ref)) : ''
  return typedOut(value === null ? {} : repo(value), fl, human, REPO_FIELDS)
}

export async function listCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const rows = (
    await listRepos(ghTransport(inv.config), inv.texts[0], fl.asInt('limit') ?? 30)
  ).map(repo)
  const human = rows
    .map(
      (row) =>
        `${textValue(row.nameWithOwner)}\t${textValue(row.description)}\t${textValue(row.visibility)}\t${textValue(row.updatedAt)}\n`,
    )
    .join('')
  return typedOut(rows, fl, human, REPO_FIELDS)
}

export async function createCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const spec = inv.texts[0] ?? ''
  if (spec === '') throw new Error('a repository name is required in noninteractive mode')
  const parts = spec.split('/')
  if (parts.length > 2 || parts.some((part) => part === '')) {
    throw new Error(`invalid repository name: "${spec}"`)
  }
  if (fl.asBool('public') && fl.asBool('private')) {
    throw new Error('--public and --private are mutually exclusive')
  }
  const owner = parts.length === 2 ? parts[0] : undefined
  const body: Record<string, unknown> = {
    name: parts.at(-1) ?? '',
    private: fl.asBool('private'),
    auto_init: fl.asBool('add_readme'),
  }
  const description = fl.asStr('description')
  const homepage = fl.asStr('homepage')
  if (description !== undefined) body.description = description
  if (homepage !== undefined) body.homepage = homepage
  const created = repo(await createRepo(ghTransport(inv.config), owner, body))
  return textOut(`${textValue(created.url)}\n`)
}

export async function fork(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const transport = ghTransport(inv.config)
  const source = ghRepo(inv.config, inv.texts[0])
  const name = fl.asStr('fork_name') ?? undefined
  const forked = (await forkRepo(transport, source, name)) as { full_name?: string }
  const full = forked.full_name ?? `${await login(transport)}/${name ?? source.repo}`
  return textOut(`✓ Created fork ${full}\n`)
}

export async function rename(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const transport = ghTransport(inv.config)
  // gh takes the *new name* as the operand and the repository to rename as
  // -R, which is the reverse of what the shape of the line suggests.
  const target = ghRepo(inv.config, fl.asStr('repo') ?? undefined)
  const name = inv.texts[0] ?? ''
  if (name === '') throw new Error('a new repository name is required')
  const renamed = (await renameRepo(transport, target, name)) as { full_name?: string }
  return textOut(`✓ Renamed repository ${renamed.full_name ?? name}\n`)
}
