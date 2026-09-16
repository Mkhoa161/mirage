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
import type { CommandFnResult } from '../../../config.ts'
import type { CLIInvocation } from '../../types.ts'
import {
  dispatchWorkflow,
  getRun,
  getWorkflow,
  listRuns,
  listWorkflows,
  rerun,
  rerunJob,
} from '../../../../core/github/actions.ts'
import { viewRepo } from '../../../../core/github/repo.ts'
import { materialize } from '../../../../io/types.ts'
import {
  camel,
  ghTransport,
  readCliFile,
  repoFor,
  textOut,
  textValue,
  typedOut,
} from './accessor.ts'

const RUN_FIELDS = [
  'attempt',
  'conclusion',
  'createdAt',
  'databaseId',
  'displayTitle',
  'event',
  'headBranch',
  'headSha',
  'name',
  'number',
  'startedAt',
  'status',
  'updatedAt',
  'url',
  'workflowDatabaseId',
  'workflowName',
] as const
const WORKFLOW_FIELDS = ['id', 'name', 'path', 'state'] as const

function run(value: unknown): Record<string, unknown> {
  const row = camel(value)
  const result = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
  if ('id' in result) {
    result.databaseId = result.id
    delete result.id
  }
  if ('htmlUrl' in result) {
    result.url = result.htmlUrl
    delete result.htmlUrl
  }
  if ('runAttempt' in result) {
    result.attempt = result.runAttempt
    delete result.runAttempt
  }
  if ('runNumber' in result) {
    result.number = result.runNumber
    delete result.runNumber
  }
  if ('workflowId' in result) {
    result.workflowDatabaseId = result.workflowId
    delete result.workflowId
  }
  result.workflowName ??= result.name ?? ''
  result.startedAt ??= result.runStartedAt
  return result
}

function workflow(value: unknown): Record<string, unknown> {
  const row = camel(value)
  return row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
}

export async function runListCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const params: Record<string, string> = {}
  for (const [flag, key] of [
    ['branch', 'branch'],
    ['commit', 'head_sha'],
    ['event', 'event'],
    ['status', 'status'],
    ['user', 'actor'],
    ['created', 'created'],
  ] as const) {
    const value = fl.asStr(flag)
    if (value !== undefined && value !== '') params[key] = value
  }
  const rows = (
    await listRuns(
      ghTransport(inv.config),
      repoFor(inv, fl),
      params,
      fl.asInt('limit') ?? 20,
      fl.asStr('workflow'),
    )
  ).map(run)
  const human = rows
    .map(
      (row) =>
        `${textValue(row.status)}\t${textValue(row.conclusion)}\t${textValue(row.displayTitle)}\t${textValue(row.workflowName)}\t${textValue(row.headBranch)}\t${textValue(row.event)}\t${textValue(row.databaseId)}\n`,
    )
    .join('')
  return typedOut(rows, fl, human, RUN_FIELDS)
}

export async function runViewCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const raw = inv.texts[0] ?? ''
  if (!/^\d+$/.test(raw)) throw new Error('a run ID is required in noninteractive mode')
  const row = run(await getRun(ghTransport(inv.config), repoFor(inv, fl), Number(raw)))
  const human = `title:\t${textValue(row.displayTitle)}\nworkflow:\t${textValue(row.workflowName)}\nstatus:\t${textValue(row.status)}\nconclusion:\t${textValue(row.conclusion)}\nbranch:\t${textValue(row.headBranch)}\nevent:\t${textValue(row.event)}\n`
  const out = await typedOut(row, fl, human, RUN_FIELDS)
  if (
    out !== null &&
    fl.asBool('exit_status') &&
    row.conclusion !== null &&
    row.conclusion !== undefined &&
    row.conclusion !== '' &&
    row.conclusion !== 'success'
  ) {
    out[1].exitCode = 1
  }
  return out
}

export async function runRerunCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const raw = inv.texts[0] ?? ''
  if (!/^\d+$/.test(raw)) throw new Error('a run ID is required in noninteractive mode')
  const transport = ghTransport(inv.config)
  const ref = repoFor(inv, fl)
  const job = fl.asStr('job')
  if (job !== undefined && job !== '') {
    if (!/^\d+$/.test(job)) throw new Error('--job expects a numeric job ID')
    await rerunJob(transport, ref, Number(job), fl.asBool('debug'))
  } else {
    await rerun(
      transport,
      ref,
      Number(raw),
      fl.asBool('failed') ? 'rerun-failed-jobs' : 'rerun',
      fl.asBool('debug') ? { enable_debug_logging: true } : undefined,
    )
  }
  return textOut('')
}

export async function workflowListCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const rows = (
    await listWorkflows(
      ghTransport(inv.config),
      repoFor(inv, fl),
      fl.asInt('limit') ?? 50,
      fl.asBool('all') ? undefined : (row) => row.state === 'active',
    )
  ).map(workflow)
  const human = rows
    .map((row) => `${textValue(row.name)}\t${textValue(row.state)}\t${textValue(row.id)}\n`)
    .join('')
  return typedOut(rows, fl, human, WORKFLOW_FIELDS)
}

export async function workflowViewCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const id = inv.texts[0] ?? ''
  if (id === '') throw new Error('a workflow ID, name, or filename is required')
  const row = workflow(await getWorkflow(ghTransport(inv.config), repoFor(inv, fl), id))
  return textOut(
    `${textValue(row.name)} - ${textValue(row.state)}\nID: ${textValue(row.id)}\nFile: ${textValue(row.path)}\n`,
  )
}

async function workflowInputs(inv: CLIInvocation, fl: FlagView): Promise<Record<string, unknown>> {
  if (fl.asBool('json')) {
    if (inv.stdin === null) throw new Error('--json needs standard input')
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(await materialize(inv.stdin)))
    } catch (err) {
      if (err instanceof SyntaxError)
        throw new Error(`invalid JSON from standard input: ${err.message}`)
      throw err
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('workflow inputs must be a JSON object')
    }
    return value as Record<string, unknown>
  }
  const inputs: Record<string, unknown> = {}
  for (const pair of fl.asList('raw_field')) {
    const at = pair.indexOf('=')
    if (at < 0) throw new Error(`expected "key=value", got "${pair}"`)
    inputs[pair.slice(0, at)] = pair.slice(at + 1)
  }
  for (const pair of fl.asList('field')) {
    const at = pair.indexOf('=')
    if (at < 0) throw new Error(`expected "key=value", got "${pair}"`)
    const value = pair.slice(at + 1)
    inputs[pair.slice(0, at)] = value.startsWith('@')
      ? new TextDecoder().decode(await readCliFile(inv, value.slice(1), '--field'))
      : value
  }
  return inputs
}

export async function workflowRunCmd(inv: CLIInvocation): Promise<CommandFnResult> {
  const fl = new FlagView(inv.flags)
  const id = inv.texts[0] ?? ''
  if (id === '') throw new Error('a workflow ID, name, or filename is required')
  const transport = ghTransport(inv.config)
  const ref = repoFor(inv, fl)
  let branch = fl.asStr('ref') ?? (inv.config as { branch?: string }).branch
  if (branch === undefined || branch === '') {
    const repository = (await viewRepo(transport, ref)) as { default_branch?: unknown }
    branch = typeof repository.default_branch === 'string' ? repository.default_branch : undefined
  }
  if (branch === undefined || branch === '') throw new Error('a workflow ref is required')
  await dispatchWorkflow(transport, ref, id, { ref: branch, inputs: await workflowInputs(inv, fl) })
  return textOut('')
}
