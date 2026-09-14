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
import { discoverHeredocs, readBody } from './reader.ts'

describe('source reader', () => {
  it('discovers two inputs without grammar hints', () => {
    const source = 'cat <<A <<B\none\nA\ntwo\nB'
    const [first, second] = discoverHeredocs(source, [])
    expect(first?.body).toBe('one\n')
    expect(second?.body).toBe('two\n')
    expect(first?.terminated && second?.terminated).toBe(true)
    expect(source.slice(second?.bodyStart, second?.end)).toBe('two\nB')
  })
  it('ignores operator text in shell words', () => {
    expect(discoverHeredocs("echo '<<X' ${x:-<<Y} $((1 << 2)) # <<Z\n", [])).toEqual([])
  })
  it('removes continuation before comparing the delimiter', () => {
    const body = readBody('keep\nEO\\\nF\nafter', 0, 'EOF', false, false)
    expect(body.body).toBe('keep\n')
    expect(body.terminated).toBe(true)
    expect(body.end).toBe(11)
  })
  it('keeps quoted continuations and tabs', () => {
    const body = readBody('\tEO\\\nF\nEOF', 0, 'EOF', true, false)
    expect(body.body).toBe('\tEO\\\nF\n')
    expect(body.terminated).toBe(true)
  })
})

it('leaves an unclosed delimiter quote as a syntax error', () => {
  expect(discoverHeredocs("cat <<'EOF\nbody", [])).toEqual([])
})
