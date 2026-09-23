import { afterEach, describe, expect, it, vi } from 'vitest'

import { SharePointAccessor } from '../../accessor/sharepoint.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { runWithRecording } from '../../observe/context.ts'
import { PathSpec } from '../../types.ts'
import { create, find, read, readdir, stream, write } from './index.ts'

function requestUrl(input: URL | RequestInfo): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SharePoint namespace listings', () => {
  it('stamps site and drive entries with the mount prefix in output and index keys', async () => {
    const fetchMock = vi.fn((input: URL | RequestInfo) => {
      const url = requestUrl(input)
      if (url.includes('/sites?')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ value: [{ id: 'site-id', displayName: 'Team', name: 'team' }] }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify({ value: [{ id: 'drive-id', name: 'Documents' }] }), {
          status: 200,
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    const index = new RAMIndexCacheStore()
    const root = PathSpec.fromStrPath('/sp', '')
    const site = PathSpec.fromStrPath('/sp/Team', 'Team')

    expect(await readdir(accessor, root, index)).toEqual(['/sp/Team'])
    expect((await index.listDir('/sp')).entries).toEqual(['/sp/Team'])
    expect(await readdir(accessor, site, index)).toEqual(['/sp/Team/Documents'])
    expect((await index.listDir('/sp/Team')).entries).toEqual(['/sp/Team/Documents'])
  })
})

// The site and library levels of an unscoped mount carry no driveId, so find
// has to walk them itself; delegating straight to findItems returned nothing
// for the whole tree.
function namespaceFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((input: URL | RequestInfo) => {
    const url = requestUrl(input)
    if (url.includes('/sites?')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ value: [{ id: 'site-id', displayName: 'Team', name: 'team' }] }),
          { status: 200 },
        ),
      )
    }
    if (url.includes('/drives?') || url.endsWith('/drives')) {
      return Promise.resolve(
        new Response(JSON.stringify({ value: [{ id: 'drive-id', name: 'Documents' }] }), {
          status: 200,
        }),
      )
    }
    if (url.includes('/root/children') || url.includes('/root:/')) {
      const nested = url.includes('sub')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            value: nested
              ? []
              : [
                  { id: '1', name: 'a.txt', size: 10 },
                  { id: '2', name: 'sub', folder: { childCount: 0 } },
                ],
          }),
          { status: 200 },
        ),
      )
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  })
}

describe('SharePoint unscoped find', () => {
  it('walks sites and libraries from the mount root', async () => {
    vi.stubGlobal('fetch', namespaceFetch())
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    expect(await find(accessor, PathSpec.fromStrPath('/sp', ''))).toEqual([
      '/',
      '/Team',
      '/Team/Documents',
      '/Team/Documents/a.txt',
      '/Team/Documents/sub',
    ])
  })

  it('counts depth from the real start path', async () => {
    vi.stubGlobal('fetch', namespaceFetch())
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    expect(await find(accessor, PathSpec.fromStrPath('/sp', ''), { maxDepth: 1 })).toEqual([
      '/',
      '/Team',
    ])
  })

  it('walks libraries from a site directory', async () => {
    vi.stubGlobal('fetch', namespaceFetch())
    const accessor = new SharePointAccessor({ accessToken: 'token' })
    expect(await find(accessor, PathSpec.fromStrPath('/sp/Team', 'Team'), { type: 'f' })).toEqual([
      '/Team/Documents/a.txt',
    ])
  })
})

// A site- and drive-scoped mount whose item `m/k.txt` is named like it.
describe('SharePoint record paths', () => {
  const spec = new PathSpec({ virtual: '/m/m/k.txt', vfsPath: 'm/k.txt', directory: '/m/m/' })

  function scopedFetch(): ReturnType<typeof vi.fn> {
    return vi.fn((input: URL | RequestInfo) => {
      const url = requestUrl(input)
      if (url.includes('/sites?')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ value: [{ id: 'site-id', displayName: 'Team', name: 'team' }] }),
            { status: 200 },
          ),
        )
      }
      if (url.includes('/drives?') || url.endsWith('/drives')) {
        return Promise.resolve(
          new Response(JSON.stringify({ value: [{ id: 'drive-id', name: 'Documents' }] }), {
            status: 200,
          }),
        )
      }
      if (url === 'https://download.test/file') {
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'item',
            cTag: 'ctag-1',
            versions: [{ id: 'v1', lastModifiedDateTime: '2026-01-01T00:00:00Z' }],
            '@microsoft.graph.downloadUrl': 'https://download.test/file',
          }),
          { status: 200 },
        ),
      )
    })
  }

  function scopedAccessor(): SharePointAccessor {
    return new SharePointAccessor({ accessToken: 'token', site: 'Team', drive: 'Documents' })
  }

  it('write records the virtual path', async () => {
    vi.stubGlobal('fetch', scopedFetch())
    const [, records] = await runWithRecording(() =>
      write(scopedAccessor(), spec, new TextEncoder().encode('hello')),
    )
    expect(records.map((r) => r.op)).toEqual(['write'])
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })

  it('create records the virtual path', async () => {
    vi.stubGlobal('fetch', scopedFetch())
    const [, records] = await runWithRecording(() => create(scopedAccessor(), spec))
    expect(records.map((r) => r.op)).toEqual(['write'])
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })

  it('read records the virtual path', async () => {
    vi.stubGlobal('fetch', scopedFetch())
    const [data, records] = await runWithRecording(() => read(scopedAccessor(), spec))
    expect([...data]).toEqual([1, 2, 3])
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })

  it('stream records the virtual path', async () => {
    vi.stubGlobal('fetch', scopedFetch())
    const [bytes, records] = await runWithRecording(async () => {
      const out: number[] = []
      for await (const chunk of stream(scopedAccessor(), spec)) out.push(...chunk)
      return out
    })
    expect(bytes).toEqual([1, 2, 3])
    expect(records.map((r) => r.path)).toEqual(['/m/m/k.txt'])
  })
})
