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
import { PyodideRuntime } from './runtime.ts'

describe('PyodideRuntime host initializer', () => {
  it('initializes once before bootstrap and disposes with the runtime', async () => {
    const ref =
      'data:text/javascript,' +
      encodeURIComponent(`
export let installs = 0
export let disposals = 0
export default function(py) {
  installs++
  py.registerJsModule('_test_capability', { add: (a, b) => a + b })
  return () => { disposals++; py.unregisterJsModule('_test_capability') }
}`)
    const module = (await import(ref)) as { installs: number; disposals: number }
    const rt = new PyodideRuntime({
      config: {
        initModule: ref,
        bootstrapCode: 'from _test_capability import add; assert add(2, 3) == 5',
      },
    })
    try {
      for (let i = 0; i < 2; i++) {
        const result = await rt.run({
          code: 'from _test_capability import add; print(add(3, 4))',
          args: [],
          env: {},
          stdin: new Uint8Array(),
        })
        expect(result.exitCode).toBe(0)
        expect(new TextDecoder().decode(result.stdout)).toBe('7\n')
      }
      expect(module.installs).toBe(1)
    } finally {
      await rt.close()
    }
    expect(module.disposals).toBe(1)
  }, 60_000)
})
