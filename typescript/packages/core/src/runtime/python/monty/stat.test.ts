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

import { describe, expect, it } from 'vitest'
import { statFields, statResult, type GuestStat } from './stat.ts'

// The numbers below are pydantic_monty's own StatResult constructors,
// read off the python binding: file_stat(size=5, mode=0o100644,
// mtime=1.5) and dir_stat(mode=0o40755, mtime=2). This file is what
// keeps the JS side reproducing them by hand.
describe('statFields', () => {
  it('reports a file the way StatResult.file_stat does', () => {
    const st = statFields({ size: 5, isDir: false, mtimeMs: 1500, mode: 0o100644 })
    expect(st).toEqual({
      st_mode: 0o100644,
      st_ino: 0,
      st_dev: 0,
      st_nlink: 1,
      st_uid: 0,
      st_gid: 0,
      st_size: 5,
      st_atime: 1.5,
      st_mtime: 1.5,
      st_ctime: 1.5,
    })
  })

  it('reports a directory as 4096 bytes and two links, whatever the backend said', () => {
    const st = statFields({ size: 17, isDir: true, mtimeMs: 2000, mode: 0o40755 })
    expect(st.st_mode).toBe(0o40755)
    expect(st.st_size).toBe(4096)
    expect(st.st_nlink).toBe(2)
  })

  it('takes the type bits from the row, not from the mode it was handed', () => {
    // A backend that reports permissions alone still yields a mode the
    // guest can mask with S_IFMT, which is what `stat.S_ISDIR` reads.
    expect(statFields({ size: 0, isDir: true, mtimeMs: 0, mode: 0o755 }).st_mode).toBe(0o40755)
    expect(statFields({ size: 0, isDir: false, mtimeMs: 0, mode: 0o644 }).st_mode).toBe(0o100644)
  })

  it('keeps an unknown stamp at zero rather than substituting the host clock', () => {
    expect(statFields({ size: 0, isDir: false, mtimeMs: 0, mode: 0o644 }).st_mtime).toBe(0)
  })
})

describe('statResult', () => {
  it('wraps the fields as a named class instance, not a bare object', () => {
    const seen: Array<[object, unknown]> = []
    class FakeClassInstance {
      constructor(instance: object, options?: { name?: string }) {
        seen.push([instance, options])
      }
    }
    const bits = {
      NOT_HANDLED: Symbol('NOT_HANDLED'),
      MontyFileHandle: class {},
      ClassInstance: FakeClassInstance,
    }
    const wrapped = statResult(bits, { size: 4, isDir: false, mtimeMs: 0, mode: 0o644 })
    expect(wrapped).toBeInstanceOf(FakeClassInstance)
    expect(seen).toHaveLength(1)
    expect((seen[0]?.[0] as GuestStat).st_size).toBe(4)
    // The name the guest sees in `type(st)` and in the repr; without
    // the wrapper the answer converts structurally and arrives as a
    // dict, where `st.st_size` raises AttributeError.
    expect(seen[0]?.[1]).toEqual({ name: 'stat_result', eagerAttrs: 'all' })
  })
})
