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
import { OPFSIndexEntry, OPFSResourceType } from './entry.ts'

describe('OPFSResourceType', () => {
  it('has FILE and FOLDER constants', () => {
    expect(OPFSResourceType.FILE).toBe('file')
    expect(OPFSResourceType.FOLDER).toBe('folder')
  })
})

describe('OPFSIndexEntry', () => {
  it('builds a file entry', () => {
    const e = OPFSIndexEntry.file('/a/b.txt', 7, '2026-01-01')
    expect(e.id).toBe('/a/b.txt')
    expect(e.name).toBe('b.txt')
    expect(e.size).toBe(7)
    expect(e.resourceType).toBe(OPFSResourceType.FILE)
  })
  it('builds a folder entry', () => {
    const e = OPFSIndexEntry.folder('/d')
    expect(e.name).toBe('d')
    expect(e.resourceType).toBe(OPFSResourceType.FOLDER)
  })
})
