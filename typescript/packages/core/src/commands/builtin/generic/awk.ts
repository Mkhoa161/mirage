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
import { FlagView } from '../../spec/flag_view.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import {
  AwkRuntimeError,
  AwkSyntaxError,
  ExitProgram,
  Interpreter,
  parse,
  text,
} from '../../../core/awk/index.ts'
import { UsageError } from '../../errors.ts'
import { FS_ESCAPES, USAGE, type AwkFlags } from './awk_types.ts'
import { isMissingPath } from '../../../utils/errors.ts'
import { resolvePath } from '../../../utils/path.ts'
import { resolveSource } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

type Stream = (p: PathSpec) => AsyncIterable<Uint8Array>

type Source = readonly [name: string, bytes: AsyncIterable<Uint8Array>]

function parseFlags(opts: CommandOpts): AwkFlags {
  const fl = new FlagView(opts.flags, specOf('awk'))
  const assignments = fl.asList('v')
  const programFiles = fl.asList('f')
  return {
    fieldSeparator: fl.asStr('F') ?? null,
    assignments,
    programFiles,
  }
}

/** Expand the backslash escapes awk reads in a -F or -v argument. */
function unescape(raw: string): string {
  let out = ''
  let idx = 0
  while (idx < raw.length) {
    if (raw.charAt(idx) === '\\' && idx + 1 < raw.length) {
      const nxt = raw.charAt(idx + 1)
      out += FS_ESCAPES[nxt] ?? '\\' + nxt
      idx += 2
      continue
    }
    out += raw.charAt(idx)
    idx += 1
  }
  return out
}

function splitAssignments(raw: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of raw) {
    const eq = item.indexOf('=')
    if (eq >= 0) out[item.slice(0, eq)] = unescape(item.slice(eq + 1))
  }
  return out
}

function exitStatus(code: number): number {
  return Number(BigInt.asUintN(8, BigInt(code)))
}

/**
 * Close a phase: move /dev/stderr text and a fatal error onto `io`.
 * Every awk treats a runtime error as fatal at exit 2 and keeps what it
 * had already written, so the pending stdout is handed back either way.
 */
function settle(io: IOResult, interp: Interpreter, failure: Error | null): Uint8Array {
  let err = interp.drainErr()
  if (failure !== null) {
    io.exitCode = 2
    err += `${failure.message}\n`
  }
  if (err !== '') {
    const held = io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : ''
    io.stderr = ENC.encode(held + err)
  }
  return ENC.encode(interp.drain())
}

function isFatal(err: unknown): err is AwkRuntimeError | AwkSyntaxError {
  return err instanceof AwkRuntimeError || err instanceof AwkSyntaxError
}

async function* awkStream(
  sources: readonly Source[],
  interp: Interpreter,
  io: IOResult,
): AsyncIterable<Uint8Array> {
  let exited = false
  try {
    interp.runBegin()
  } catch (err) {
    if (err instanceof ExitProgram) {
      io.exitCode = exitStatus(err.code)
      exited = true
    } else if (isFatal(err)) {
      yield settle(io, interp, err)
      return
    } else throw err
  }
  yield settle(io, interp, null)
  if (!exited && interp.hasMainRules()) {
    for (const [name, source] of sources) {
      if (exited) break
      interp.startFile(name)
      for await (const lineBytes of new AsyncLineIterator(source)) {
        try {
          interp.runRecord(DEC.decode(lineBytes))
        } catch (err) {
          if (err instanceof ExitProgram) {
            io.exitCode = exitStatus(err.code)
            exited = true
          } else if (isFatal(err)) {
            yield settle(io, interp, err)
            return
          } else throw err
        }
        const chunk = settle(io, interp, null)
        if (chunk.length > 0) yield chunk
        if (exited || interp.skipFile) break
      }
    }
  }
  try {
    interp.runEnd()
  } catch (err) {
    if (err instanceof ExitProgram) io.exitCode = exitStatus(err.code)
    else if (isFatal(err)) {
      yield settle(io, interp, err)
      return
    } else throw err
  }
  yield settle(io, interp, null)
}

export async function awkGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: Stream,
): Promise<CommandFnResult> {
  const f = parseFlags(opts)
  let program: string
  if (f.programFiles.length > 0) {
    const mountPrefix =
      (paths[0] === undefined ? undefined : mountPrefixOf(paths[0].virtual, paths[0].vfsPath)) ??
      opts.mountPrefix ??
      ''
    const pieces: string[] = []
    for (const programFile of f.programFiles) {
      // A relative -f resolves against the cwd, like the shell classifier
      // resolves python's PathSpec flag values.
      const virtual = resolvePath(programFile, opts.cwd)
      const programSpec = PathSpec.fromStrPath(virtual, mountKey(virtual, mountPrefix))
      try {
        pieces.push(DEC.decode(await materialize(stream(programSpec))))
      } catch (err) {
        // GNU awk exits 2 when a -f program file cannot be opened;
        // anything that is not absence keeps propagating.
        if (!isMissingPath(err)) throw err
        const msg = `awk: ${programFile}: No such file or directory`
        return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${msg}\n`) })]
      }
    }
    program = pieces.join('\n')
  } else if (texts.length > 0 && texts[0] !== undefined) {
    program = texts[0]
  } else {
    return [null, new IOResult({ exitCode: 2, stderr: ENC.encode(`${USAGE}\n`) })]
  }

  let interp: Interpreter
  try {
    interp = new Interpreter(parse(program), splitAssignments(f.assignments))
  } catch (err) {
    if (err instanceof AwkSyntaxError) throw new UsageError(err.message)
    throw err
  }
  if (f.fieldSeparator !== null) interp.setVar('FS', text(unescape(f.fieldSeparator)))

  let sources: Source[]
  let cache: string[]
  if (paths.length > 0) {
    // FILENAME reports the operand as typed, matching every awk.
    sources = paths.map((p) => [p.rawPath, stream(p)] as const)
    cache = paths.map((p) => p.mountPath)
  } else {
    sources = [['', resolveSource(opts.stdin)]]
    cache = []
  }
  const io = new IOResult({ cache })
  return [awkStream(sources, interp, io), io]
}
