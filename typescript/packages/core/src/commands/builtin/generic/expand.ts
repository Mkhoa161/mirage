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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { readStdinAsync } from '../utils/stream.ts'
import { operandsIo, readOperands } from '../utils/operands.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function expandTabs(text: string, tabsize: number): string {
  const out: string[] = []
  let col = 0
  for (const ch of text) {
    if (ch === '\t') {
      const spaces = tabsize - (col % tabsize)
      out.push(' '.repeat(spaces))
      col += spaces
    } else if (ch === '\n') {
      out.push(ch)
      col = 0
    } else {
      out.push(ch)
      col += 1
    }
  }
  return out.join('')
}

function expandLeadingTabs(text: string, tabsize: number): string {
  const lines = text.split('\n')
  const result: string[] = []
  for (const line of lines) {
    let i = 0
    while (i < line.length && (line[i] === '\t' || line[i] === ' ')) i += 1
    if (i === 0) {
      result.push(line)
    } else {
      const leading = line.slice(0, i)
      const rest = line.slice(i)
      result.push(expandTabs(leading, tabsize) + rest)
    }
  }
  return result.join('\n')
}

function applyExpand(txt: string, leadingOnly: boolean, tabsize: number): string {
  return leadingOnly ? expandLeadingTabs(txt, tabsize) : expandTabs(txt, tabsize)
}

export async function expandGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const fl = new FlagView(opts.flags, specOf('expand'))
  const tabsValue = fl.asStr('tabs')
  // GNU refuses a tab size it cannot read whole, before it opens an operand,
  // and quotes from the first character it could not parse onward:
  // `--tabs=8x` reports 'x' while `--tabs=abc` and `--tabs=-4` both report
  // the whole argument (for `-4` the first unparseable character is at
  // position 0, because `-` is not a sign here; a leading `+` is, and `+4`
  // reads as 4). An empty value is not an error: `--tabs=''` is an empty
  // tab-stop list, which leaves expand on its default 8. Pre-validated the
  // way head/tail do it, so the parseInt below cannot hand back a prefix or
  // NaN.
  const tabsGiven = tabsValue !== undefined && tabsValue !== ''
  if (tabsGiven && !/^\+?\d+$/.test(tabsValue)) {
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode(
          `expand: tab size contains invalid character(s): '${tabsValue.replace(/^\+?\d*/, '')}'\n`,
        ),
      }),
    ]
  }
  const tabsize = tabsGiven ? Number.parseInt(tabsValue, 10) : 8
  const leadingOnly = fl.asBool('initial')
  if (paths.length > 0) {
    // A missing operand is reported and skipped; the remaining operands
    // still expand (GNU expand).
    const [ok, err] = await readOperands(paths, stream, 'expand')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    const parts: string[] = []
    for (const o of ok) {
      parts.push(applyExpand(DEC.decode(o.data), leadingOnly, tabsize))
    }
    const result: ByteSource = ENC.encode(parts.join(''))
    return [result, io]
  }
  const stdinData = await readStdinAsync(opts.stdin)
  if (stdinData === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('expand: missing operand\n') })]
  }
  const text = DEC.decode(stdinData)
  const result: ByteSource = ENC.encode(applyExpand(text, leadingOnly, tabsize))
  return [result, new IOResult()]
}
