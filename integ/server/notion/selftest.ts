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

import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'
import type { JsonValue } from '../kit/typescript/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const TENANT = 'selftest-notion'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`notion selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue | undefined, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? '' : `got ${a} want ${b}`)
}

interface Fake {
  child: ChildProcessByStdio<null, Readable, Readable>
  endpoint: string
}

async function launch(): Promise<Fake> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0'],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  const first = await new Promise<string>((ok, bad) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl !== -1) ok(out.slice(0, nl))
    })
    child.on('exit', (code) => {
      bad(new Error(`fake exited ${String(code)} before announcing\n${err}`))
    })
  })
  check('announce line matches ANNOUNCE_RE', ANNOUNCE_RE.test(first), first)
  return { child, endpoint: first.split('=').slice(1).join('=') }
}

const PAGE = 'aaaa1111-2222-3333-4444-555566667777'

function paragraph(content: string): JsonValue {
  return { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content } }] } }
}

async function request(
  at: string,
  method: string,
  path: string,
  body?: JsonValue,
  status = 200,
): Promise<Record<string, JsonValue>> {
  const response = await fetch(at + path, {
    method,
    headers: {
      Authorization: `Bearer ${TENANT}`,
      'Notion-Version': '2025-09-03',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = (await response.json()) as Record<string, JsonValue>
  eq(`${method} ${path} status`, response.status, status)
  if (status === 400) {
    eq(
      'validation error envelope',
      [value.object ?? null, value.status ?? null, value.code ?? null],
      ['error', 400, 'validation_error'],
    )
  }
  return value
}

function results(body: Record<string, JsonValue>): Record<string, JsonValue>[] {
  return body.results as Record<string, JsonValue>[]
}

async function main(): Promise<void> {
  const fake = await launch()
  const at = fake.endpoint
  try {
    await request(at, 'POST', '/reset', { tenants: [TENANT], fixture: 'v1' })
    for (const type of ['heading_1', 'heading_2', 'heading_3', 'divider', 'image', 'code']) {
      const payload: JsonValue =
        type === 'image'
          ? { type: 'external', external: { url: 'https://example.com/a.png' } }
          : type === 'divider'
            ? {}
            : { rich_text: [], ...(type === 'code' ? { language: 'plain text' } : {}) }
      const made = results(
        await request(at, 'PATCH', `/v1/blocks/${PAGE}/children`, {
          children: [{ type, [type]: payload }],
        }),
      )[0]!
      const id = String(made.id)
      await request(
        at,
        'PATCH',
        `/v1/blocks/${id}/children`,
        { children: [paragraph('refused')] },
        400,
      )
      eq(
        'refused parent stays childless',
        (await request(at, 'GET', `/v1/blocks/${id}`)).has_children,
        false,
      )
      eq(
        'refused append inserts no children',
        results(await request(at, 'GET', `/v1/blocks/${id}/children`)),
        [],
      )
    }
    const heading = results(
      await request(at, 'PATCH', `/v1/blocks/${PAGE}/children`, {
        children: [{ type: 'heading_1', heading_1: { rich_text: [], is_toggleable: true } }],
      }),
    )[0]!
    const hid = String(heading.id)
    await request(at, 'PATCH', `/v1/blocks/${hid}/children`, { children: [paragraph('nested')] })
    const renamed = await request(at, 'PATCH', `/v1/blocks/${hid}`, {
      heading_1: { rich_text: [{ text: { content: 'Renamed' } }] },
    })
    eq(
      'update preserves omitted toggle state',
      (renamed.heading_1 as Record<string, JsonValue>).is_toggleable,
      true,
    )
    eq('update preserves children', renamed.has_children, true)
    eq(
      'rich text normalized',
      (
        (renamed.heading_1 as Record<string, JsonValue>).rich_text as Record<string, JsonValue>[]
      )[0]!.plain_text,
      'Renamed',
    )
    await request(at, 'PATCH', `/v1/blocks/${hid}`, { heading_1: { is_toggleable: false } }, 400)
    await request(at, 'PATCH', `/v1/blocks/${hid}`, { type: { heading_1: { rich_text: [] } } }, 400)
    await request(at, 'PATCH', `/v1/blocks/${hid}`, { heading_1: { children: [] } }, 400)
    await request(at, 'PATCH', '/v1/blocks/00000000-0000-0000-0000-000000000000', {}, 404)
    await request(at, 'PATCH', `/v1/blocks/${hid}`, { archived: true })
    eq(
      'archive alias visible on read',
      (await request(at, 'GET', `/v1/blocks/${hid}`)).in_trash,
      true,
    )
    await request(at, 'PATCH', `/v1/blocks/${hid}`, { in_trash: false })

    const before = results(await request(at, 'GET', `/v1/blocks/${PAGE}/children`))
    for (const children of [
      [JSON.stringify(paragraph('bad'))],
      [paragraph('valid'), { type: 'divider', divider: { children: [paragraph('invalid')] } }],
      null,
    ]) {
      await request(
        at,
        'POST',
        '/v1/pages',
        { parent: { page_id: PAGE }, properties: {}, children },
        400,
      )
      eq(
        'invalid page leaves parent unchanged',
        results(await request(at, 'GET', `/v1/blocks/${PAGE}/children`)),
        before,
      )
    }
    await request(
      at,
      'PATCH',
      `/v1/blocks/${PAGE}/children`,
      { after: before[0]!.id!, children: [paragraph('valid'), 'invalid'] },
      400,
    )
    eq(
      'invalid append does not insert or reorder',
      results(await request(at, 'GET', `/v1/blocks/${PAGE}/children`)),
      before,
    )
    const page = await request(at, 'POST', '/v1/pages', {
      parent: { page_id: PAGE },
      properties: { title: { title: [{ text: { content: 'With children' } }] } },
      children: [
        paragraph('first'),
        { type: 'toggle', toggle: { rich_text: [], children: [paragraph('inside')] } },
        paragraph('last'),
      ],
    })
    const blocks = results(await request(at, 'GET', `/v1/blocks/${String(page.id)}/children`))
    eq(
      'page children retain order',
      blocks.map((block) => block.type!),
      ['paragraph', 'toggle', 'paragraph'],
    )
    eq('nested child tracked separately', blocks[1]!.has_children, true)
    check(
      'children omitted from returned payload',
      !('children' in (blocks[1]!.toggle as Record<string, JsonValue>)),
    )
    const nested = results(await request(at, 'GET', `/v1/blocks/${String(blocks[1]!.id)}/children`))
    eq(
      'nested child readable',
      (
        (nested[0]!.paragraph as Record<string, JsonValue>).rich_text as Record<string, JsonValue>[]
      )[0]!.plain_text,
      'inside',
    )
    process.stdout.write(`notion selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
