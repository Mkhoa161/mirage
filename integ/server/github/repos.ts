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

import type { JsonValue, KitRoute } from '../kit/typescript/index.ts'
import { API_PREFIXES, DEFAULT_LOGIN } from './config.ts'
import type { C } from './config.ts'
import { commitJson } from './wire.ts'
import { createReposAllowed, initRepo } from './seed.ts'
import {
  addBranch,
  allRepos,
  delegateFor,
  perRepoModels,
  branchFor,
  branchNames,
  commitList,
  metaOf,
  repoByName,
  treeOfBranch,
} from './store.ts'
import type { RepoRow } from './store.ts'
import {
  authedRoute as authed,
  everywhere,
  fail,
  jsonBodyOf,
  pagedReply,
  param,
  route,
  str,
  withRepo,
} from './http.ts'
import type { Handler } from './http.ts'

// The repository shape every route returns. A fixture's own values win, except
// default_branch, which seeding decides.
export function repoJson(repo: RepoRow): JsonValue {
  const meta = metaOf(repo)
  const { default_branch: _ignored, ...rest } = meta
  return {
    name: repo.name,
    full_name: repo.fullName,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
    html_url: `https://github.com/${repo.fullName}`,
    description: null,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    language: null,
    topics: [],
    archived: false,
    fork: false,
    ...rest,
  }
}

async function branchJson(
  ctx: { db: C; tenant: string },
  repo: RepoRow,
  branch: string,
): Promise<JsonValue> {
  const list = await commitList(ctx.db, ctx.tenant, repo, branch)
  return { name: branch, commit: { sha: list[0]?.sha ?? '' } }
}

async function nextRepoSeq(db: C, tenant: string): Promise<number> {
  const rows = await allRepos(db, tenant)
  return rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.seq)) + 1
}

export function repoRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>(
      'GET',
      `${p}/user`,
      authed(() => ({
        status: 200,
        body: { login: DEFAULT_LOGIN, name: DEFAULT_LOGIN, type: 'User' },
      })),
    ),
    // Whether a named owner is the user or an organization.
    route<C>(
      'GET',
      `${p}/users/:owner`,
      authed((ctx) => {
        const owner = param(ctx, 'owner')
        return {
          status: 200,
          body: { login: owner, type: owner === DEFAULT_LOGIN ? 'User' : 'Organization' },
        }
      }),
    ),
    // The API root, so a client probing it gets "this is a GitHub API" rather
    // than a 404, which reads as the host not being there at all.
    // The python fake registers the root as "/" bare and as "/api/v3/" with a
    // trailing slash, and the kit router matches a path exactly, so the two
    // spellings are not interchangeable.
    // The URL map is built from the bare origin at BOTH spellings: the python
    // fake answers its own base URL, which never carried the Enterprise prefix,
    // and a template that suddenly gained one would send a client somewhere it
    // was not sent before.
    route<C>('GET', p === '' ? '/' : `${p}/`, (ctx) => {
      const host = ctx.headers.host ?? '127.0.0.1'
      // Every url in this map is one the client is expected to follow, so the
      // run rides them too. This is the API root: a scoped client that starts
      // here and follows current_user_repositories_url would otherwise walk
      // straight into the default run and read another world's repositories.
      // runPrefix is '' for an unscoped request, so the map is unchanged for
      // one, which is what the Enterprise-prefix note below is about.
      const base = `http://${String(host)}${ctx.runPrefix}`
      return {
        status: 200,
        body: {
          current_user_url: `${base}/user`,
          current_user_repositories_url: `${base}/user/repos`,
          user_url: `${base}/users/{user}`,
          repository_url: `${base}/repos/{owner}/{repo}`,
          repository_search_url: `${base}/search/repositories?q={query}`,
          code_search_url: `${base}/search/code?q={query}`,
        },
      }
    }),
    route<C>('GET', `${p}/user/repos`, authed(listRepos)),
    route<C>('GET', `${p}/users/:owner/repos`, authed(listRepos)),
    route<C>('GET', `${p}/orgs/:owner/repos`, authed(listRepos)),
    route<C>('POST', `${p}/user/repos`, authed(createRepo), { write: true }),
    route<C>('POST', `${p}/orgs/:owner/repos`, authed(createRepo), { write: true }),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo`,
      authed(withRepo((_c, r) => ({ status: 200, body: repoJson(r) }))),
    ),
    route<C>('PATCH', `${p}/repos/:owner/:repo`, authed(updateRepo), { write: true }),
    route<C>('DELETE', `${p}/repos/:owner/:repo`, authed(deleteRepo), { write: true }),
    route<C>('POST', `${p}/repos/:owner/:repo/forks`, authed(forkRepo), { write: true }),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/branches`,
      authed(
        withRepo(async (ctx, repo) => {
          const names = await branchNames(ctx.db, ctx.tenant, repo)
          const out: JsonValue[] = []
          for (const b of names) out.push(await branchJson(ctx, repo, b))
          return { status: 200, body: out }
        }),
      ),
    ),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/branches/:branch`,
      authed(
        withRepo(async (ctx, repo) => {
          const name = param(ctx, 'branch')
          const names = await branchNames(ctx.db, ctx.tenant, repo)
          if (!names.includes(name)) return fail(404, 'Branch not found')
          return { status: 200, body: await branchJson(ctx, repo, name) }
        }),
      ),
    ),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/commits`,
      authed(
        // Not paged, unlike the repository list: the vendor pages this one and
        // the fake this replaces answered the whole history, which is what the
        // goldens record. An unresolvable `sha` falls back to the default
        // branch rather than 404ing, also matching it.
        withRepo(async (ctx, repo) => {
          const asked = ctx.query.get('sha') ?? ''
          const branch = (await branchFor(ctx.db, ctx.tenant, repo, asked)) ?? repo.defaultBranch
          const list = await commitList(ctx.db, ctx.tenant, repo, branch)
          return { status: 200, body: list.map(commitJson) }
        }),
      ),
    ),
  ])
}

const listRepos: Handler = async (ctx) => {
  const owner = ctx.params.owner ?? DEFAULT_LOGIN
  const repos = await allRepos(ctx.db, ctx.tenant)
  const items = repos
    .filter((r) => r.owner === owner)
    .sort((a, b) => (a.fullName < b.fullName ? -1 : 1))
    .map(repoJson)
  return pagedReply(ctx, items)
}

const createRepo: Handler = async (ctx) => {
  if (!(await createReposAllowed(ctx.db, ctx.tenant))) {
    return fail(403, 'Resource not accessible by personal access token')
  }
  const body = jsonBodyOf(ctx)
  const name = str(body, 'name').trim()
  if (name === '') return fail(422, 'Repository creation failed.')
  const owner = ctx.params.owner ?? DEFAULT_LOGIN
  const fullName = `${owner}/${name}`
  if ((await repoByName(ctx.db, ctx.tenant, fullName)) !== null) {
    return fail(422, 'Repository creation failed.')
  }
  const priv = body.private === true
  const meta: Record<string, JsonValue> = {
    description: body.description ?? null,
    homepage: body.homepage ?? null,
    private: priv,
    visibility: priv ? 'private' : 'public',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
  }
  const created = (await ctx.db.githubRepo.create({
    data: {
      tenant: ctx.tenant,
      fullName,
      owner,
      name,
      defaultBranch: 'main',
      metaJson: JSON.stringify(meta),
      seq: await nextRepoSeq(ctx.db, ctx.tenant),
    },
  })) as RepoRow
  await initRepo(ctx.db, ctx.tenant, created)
  if (body.auto_init === true) {
    await ctx.db.githubFile.create({
      data: {
        tenant: ctx.tenant,
        repo: fullName,
        branch: 'main',
        path: 'README.md',
        data: new Uint8Array(Buffer.from(`# ${name}\n`, 'utf8')),
        seq: 0,
      },
    })
  }
  return { status: 201, body: repoJson(created) }
}

// A rename has to carry the content with it rather than leave an empty
// repository behind under the new name, which is what a fork-then-rename does.
const updateRepo: Handler = authed(
  withRepo(async (ctx, repo) => {
    const body = jsonBodyOf(ctx)
    const name = str(body, 'name').trim()
    let current = repo
    if (name !== '' && name !== repo.name) {
      const target = `${repo.owner}/${name}`
      if ((await repoByName(ctx.db, ctx.tenant, target)) !== null) {
        return fail(422, 'Repository creation failed.')
      }
      current = (await renameRepo(ctx.db, ctx.tenant, repo, name)) as RepoRow
    }
    const branch = str(body, 'default_branch').trim()
    if (branch !== '') {
      current = (await ctx.db.githubRepo.update({
        where: { tenant_fullName: { tenant: ctx.tenant, fullName: current.fullName } },
        data: { defaultBranch: branch },
      })) as RepoRow
    }
    return { status: 200, body: repoJson(current) }
  }),
)

// Every child row keys on the repository's full name, so a rename is a rename
// of that key everywhere, not just on the repository row.
async function renameRepo(db: C, tenant: string, repo: RepoRow, name: string): Promise<RepoRow> {
  const to = `${repo.owner}/${name}`
  const from = repo.fullName
  const created = (await db.githubRepo.create({
    data: {
      tenant,
      fullName: to,
      owner: repo.owner,
      name,
      defaultBranch: repo.defaultBranch,
      metaJson: repo.metaJson,
      truncated: repo.truncated,
      sourceDir: repo.sourceDir,
      sourceBranch: repo.sourceBranch,
      seq: repo.seq,
    },
  })) as RepoRow
  // Derived from the schema, not listed here. Every relation to GithubRepo is
  // required and none cascades, so a table left behind is not a silent orphan,
  // it is a 500 on the delete below. That list went stale twice, once for
  // GithubStagedTree and once for GithubBranch, so it is no longer written
  // down: `perRepoModels` reads the DMMF, and a model added to the schema is
  // moved without anyone remembering to say so.
  for (const model of perRepoModels()) {
    await delegateFor(db, model).updateMany({ where: { tenant, repo: from }, data: { repo: to } })
  }
  await db.githubRepo.delete({ where: { tenant_fullName: { tenant, fullName: from } } })
  return created
}

const deleteRepo: Handler = authed(
  withRepo(async (ctx, repo) => {
    await dropRepo(ctx.db, ctx.tenant, repo.fullName)
    return { status: 204 }
  }),
)

async function dropRepo(db: C, tenant: string, fullName: string): Promise<void> {
  const where = { tenant, repo: fullName }
  // A staged entry hangs off a staged TREE rather than off the repository, so
  // it is the one child the schema walk cannot reach: entries are keyed by tree
  // sha, and they have to go before the trees they require.
  const staged = await db.githubStagedTree.findMany({ where, select: { sha: true } })
  await db.githubStagedEntry.deleteMany({
    where: { tenant, treeSha: { in: staged.map((t) => t.sha) } },
  })
  // In dependency order, deepest first, for the same reason the kit's own
  // scoped reset derives its order rather than declaring one.
  for (const model of perRepoModels()) {
    await delegateFor(db, model).deleteMany({ where })
  }
  await db.githubRepo.delete({ where: { tenant_fullName: { tenant, fullName } } })
}

const forkRepo: Handler = authed(
  withRepo(async (ctx, source) => {
    const body = jsonBodyOf(ctx)
    const name = str(body, 'name').trim() === '' ? source.name : str(body, 'name').trim()
    const fullName = `${DEFAULT_LOGIN}/${name}`
    const existing = await repoByName(ctx.db, ctx.tenant, fullName)
    if (existing !== null) return { status: 202, body: repoJson(existing) }
    const fork = (await ctx.db.githubRepo.create({
      data: {
        tenant: ctx.tenant,
        fullName,
        owner: DEFAULT_LOGIN,
        name,
        defaultBranch: source.defaultBranch,
        metaJson: source.metaJson,
        seq: await nextRepoSeq(ctx.db, ctx.tenant),
      },
    })) as RepoRow
    // The defaults, not the source's: the python fork built a fresh FakeRepo and
    // copied only the branch trees, submodules and metadata onto it, so a fork
    // does not inherit the source's issues, releases or runs.
    await initRepo(ctx.db, ctx.tenant, fork)
    for (const branch of await branchNames(ctx.db, ctx.tenant, source)) {
      await addBranch(ctx.db, ctx.tenant, fullName, branch)
      const tree = await treeOfBranch(ctx.db, ctx.tenant, source, branch)
      let seq = 0
      for (const [path, data] of tree) {
        await ctx.db.githubFile.create({
          data: {
            tenant: ctx.tenant,
            repo: fullName,
            branch,
            path,
            data: new Uint8Array(data),
            seq,
          },
        })
        seq += 1
      }
    }
    const subs = await ctx.db.githubSubmodule.findMany({
      where: { tenant: ctx.tenant, repo: source.fullName },
      orderBy: { path: 'asc' },
    })
    for (const s of subs) {
      await ctx.db.githubSubmodule.create({
        data: { tenant: ctx.tenant, repo: fullName, path: s.path },
      })
    }
    return { status: 202, body: repoJson(fork) }
  }),
)
