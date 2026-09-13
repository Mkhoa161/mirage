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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { materialize } from '../../../io/types.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { GENERAL_CURL } from './curl.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

interface FetchCall {
  url: string
  init?: RequestInit
}

const RESPONSE_HEADERS: [string, string][] = [
  ['Content-Type', 'text/plain'],
  ['Content-Length', '10'],
]

function mockFetch(respBody: string, status = 200): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    calls.push({ url: urlStr, ...(init !== undefined ? { init } : {}) })
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      arrayBuffer: () => Promise.resolve(ENC.encode(respBody).buffer),
      text: () => Promise.resolve(respBody),
      headers: new Headers(RESPONSE_HEADERS),
    } as unknown as Response)
  }) as typeof fetch
  return calls
}

// A server that never answers: the fetch settles only when the caller's
// signal aborts it, the way a real stalled connection would.
function mockStall(): void {
  globalThis.fetch = vi.fn(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      }),
  ) as typeof fetch
}

async function runCurl(
  texts: string[],
  flags: Record<string, string | boolean | number | string[]> = {},
): Promise<{
  out: string
  err: string
  exitCode: number
  writes: Record<string, Uint8Array | AsyncIterable<Uint8Array>>
}> {
  const resource = new RAMResource()
  const cmd = GENERAL_CURL[0]
  if (cmd === undefined) throw new Error('curl not registered')
  const result = await cmd.fn((resource as { accessor?: unknown }).accessor as never, [], texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) return { out: '', err: '', exitCode: -1, writes: {} }
  const [out, ioResult] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return {
    out: DEC.decode(buf),
    err: await ioResult.stderrStr(),
    exitCode: ioResult.exitCode,
    writes: ioResult.writes,
  }
}

describe('curl', () => {
  const original = globalThis.fetch
  beforeEach(() => {
    mockFetch('hello body')
  })
  afterEach(() => {
    globalThis.fetch = original
  })

  it('GET returns body', async () => {
    const r = await runCurl(['https://x.test/hi'])
    expect(r.out).toBe('hello body')
    expect(r.exitCode).toBe(0)
  })

  // Real curl prints nothing on stdout with -o: the body goes to the file and
  // the only stdout-adjacent output is the progress meter, which is on stderr.
  it('-o writes to file and prints nothing on stdout', async () => {
    const r = await runCurl(['https://x.test/file'], { output: '/tmp/out.txt' })
    const written = r.writes['/tmp/out.txt']
    expect(written).toBeInstanceOf(Uint8Array)
    if (written instanceof Uint8Array) {
      expect(DEC.decode(written)).toBe('hello body')
    }
    expect(r.out).toBe('')
  })

  it('-s with -o silences stdout', async () => {
    const r = await runCurl(['https://x.test/x'], { output: '/tmp/o', silent: true })
    expect(r.out).toBe('')
  })

  it('-X POST -d sends body', async () => {
    const calls = mockFetch('ok')
    const r = await runCurl(['https://x.test/p'], { request: 'POST', data: 'payload' })
    expect(r.exitCode).toBe(0)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(new TextDecoder().decode(calls[0]?.init?.body as ArrayBuffer)).toBe('payload')
  })

  it('-H adds headers', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'], { header: 'X-Auth: token' })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['X-Auth']).toBe('token')
  })

  it('sends default Mozilla User-Agent when none provided', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'])
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['User-Agent']).toMatch(/^Mozilla\/5\.0/)
  })

  it('-A overrides default User-Agent', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'], { user_agent: 'my-agent/9' })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('my-agent/9')
  })

  it('-H User-Agent overrides default', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/p'], { header: 'User-Agent: from-H/1' })
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['User-Agent']).toBe('from-H/1')
  })

  it('missing URL is a usage error with exit 2', async () => {
    await expect(runCurl([])).rejects.toMatchObject({ exitCode: 2 })
  })

  // Pinned against curl 8.14.1: an HTTP error status is a successful transfer.
  // The body is printed and the exit code stays 0 unless -f is given.
  it('prints the body and exits 0 on a 404 without -f', async () => {
    mockFetch('not found', 404)
    const r = await runCurl(['https://x.test/missing'])
    expect(r.exitCode).toBe(0)
    expect(r.out).toBe('not found')
  })

  it('writes the error body to -o and exits 0 on a 404 without -f', async () => {
    mockFetch('not found', 404)
    const r = await runCurl(['https://x.test/missing'], { output: '/tmp/e.txt' })
    expect(r.exitCode).toBe(0)
    const written = r.writes['/tmp/e.txt']
    if (written instanceof Uint8Array) expect(DEC.decode(written)).toBe('not found')
  })

  it('-f turns a 404 into exit 22 and writes nothing', async () => {
    mockFetch('not found', 404)
    const r = await runCurl(['https://x.test/missing'], { fail: true, output: '/tmp/e.txt' })
    expect(r.exitCode).toBe(22)
    expect(r.err).toContain('curl: (22) The requested URL returned error: 404')
    expect(Object.keys(r.writes)).toHaveLength(0)
  })

  it('-sf keeps exit 22 but silences the message', async () => {
    mockFetch('not found', 404)
    const r = await runCurl(['https://x.test/missing'], { fail: true, silent: true })
    expect(r.exitCode).toBe(22)
    expect(r.err).toBe('')
  })

  it('-sSf restores the message', async () => {
    mockFetch('not found', 404)
    const r = await runCurl(['https://x.test/missing'], {
      fail: true,
      silent: true,
      show_error: true,
    })
    expect(r.exitCode).toBe(22)
    expect(r.err).toContain('curl: (22)')
  })

  it('reports a refused connection as exit 7', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
    const r = await runCurl(['http://127.0.0.1:1/x'])
    expect(r.exitCode).toBe(7)
    expect(r.err).toContain('curl: (7) Failed to connect to 127.0.0.1 port 1')
  })

  it('only follows redirects when -L is given', async () => {
    const calls = mockFetch('ok')
    await runCurl(['https://x.test/r'])
    expect(calls[0]?.init?.redirect).toBe('manual')
    const withL = mockFetch('ok')
    await runCurl(['https://x.test/r'], { location: true })
    expect(withL[0]?.init?.redirect).toBe('follow')
  })
})

// Pinned against curl 8.7.1 / 8.14.1 (byte shapes captured with `cat -ve`
// against a local python http.server). Header names render lowercase in
// both hosts because fetch never exposes the wire casing, and the status
// line always says HTTP/1.1 because fetch cannot observe the version.
const RESPONSE_DUMP = 'HTTP/1.1 200 OK\r\ncontent-length: 10\r\ncontent-type: text/plain\r\n\r\n'

describe('curl option surface (#1065)', () => {
  const original = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = original
  })

  it('long spellings reach the request', async () => {
    const calls = mockFetch('ok')
    await runCurl(['http://x.test/echo'], {
      request: 'PUT',
      header: 'X-Mirage-Test: yes',
      user_agent: 'agent/1',
    })
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(calls[0]?.init?.headers).toEqual({ 'X-Mirage-Test': 'yes', 'User-Agent': 'agent/1' })
  })

  it('--max-time turns a stalled transfer into exit 28', async () => {
    mockStall()
    const r = await runCurl(['http://x.test/f'], { max_time: 0.05 })
    expect(r.exitCode).toBe(28)
    expect(r.out).toBe('')
    expect(r.err).toMatch(
      /^curl: \(28\) Operation timed out after \d+ milliseconds with 0 bytes received\n$/,
    )
  })

  it('-s silences the timeout message but keeps exit 28', async () => {
    mockStall()
    const r = await runCurl(['http://x.test/f'], { max_time: 0.05, silent: true })
    expect(r.exitCode).toBe(28)
    expect(r.err).toBe('')
  })

  it('-v dumps the request and response headers on stderr', async () => {
    mockFetch('hello body')
    const r = await runCurl(['http://x.test/f?q=1'], { verbose: true })
    expect(r.out).toBe('hello body')
    expect(r.exitCode).toBe(0)
    const responseLines = RESPONSE_DUMP.split('\r\n').slice(0, -1)
    expect(r.err).toBe(
      '> GET /f?q=1 HTTP/1.1\r\n' +
        '> Host: x.test\r\n' +
        '> User-Agent: Mozilla/5.0 (compatible; mirage/1.0)\r\n' +
        '> Accept: */*\r\n' +
        '> \r\n' +
        responseLines.map((line) => `< ${line}\r\n`).join(''),
    )
  })

  it('-v shows custom headers and the body headers', async () => {
    mockFetch('ok')
    const r = await runCurl(['http://x.test:8080/f'], {
      verbose: true,
      silent: true,
      request: 'POST',
      header: 'X-Test: 1',
      user_agent: 'agent/1',
      data: 'a=1',
    })
    expect(r.err.split('< ')[0]).toBe(
      '> POST /f HTTP/1.1\r\n' +
        '> Host: x.test:8080\r\n' +
        '> User-Agent: agent/1\r\n' +
        '> Accept: */*\r\n' +
        '> X-Test: 1\r\n' +
        '> Content-Length: 3\r\n' +
        '> Content-Type: application/x-www-form-urlencoded\r\n' +
        '> \r\n',
    )
  })

  it('-I prints the headers and sends HEAD', async () => {
    const calls = mockFetch('')
    const r = await runCurl(['http://x.test/f'], { head: true })
    expect(calls[0]?.init?.method).toBe('HEAD')
    expect(r.out).toBe(RESPONSE_DUMP)
    expect(r.exitCode).toBe(0)
  })

  it('-i prints the headers before the body', async () => {
    mockFetch('hello body')
    const r = await runCurl(['http://x.test/f'], { include: true })
    expect(r.out).toBe(`${RESPONSE_DUMP}hello body`)
  })

  it('-i with -o writes headers and body to the file', async () => {
    mockFetch('hello body')
    const r = await runCurl(['http://x.test/f'], { include: true, output: '/tmp/out.txt' })
    expect(r.out).toBe('')
    expect(DEC.decode(r.writes['/tmp/out.txt'] as Uint8Array)).toBe(`${RESPONSE_DUMP}hello body`)
  })
})
