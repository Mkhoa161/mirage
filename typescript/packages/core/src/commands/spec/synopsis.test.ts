import { describe, expect, it } from 'vitest'
import { BUILTIN_SPECS, specOf } from './builtins.ts'
import { renderHelp } from './help.ts'
import { SYNOPSES } from './synopsis.ts'
import { CommandSpec, UsageStyle } from './types.ts'

describe('SYNOPSES', () => {
  it('names a builtin with every entry, each starting with the command', () => {
    for (const [name, line] of Object.entries(SYNOPSES)) {
      expect(name in BUILTIN_SPECS).toBe(true)
      expect(line.split(' ', 1)[0]).toBe(name)
      expect(line.startsWith('Usage:')).toBe(false)
    }
  })

  it('is what --help prints for a listed command', () => {
    expect(renderHelp('grep', specOf('grep'))).toContain(
      'Usage: grep [OPTION]... PATTERNS [FILE]...\n',
    )
  })

  it('leaves an unlisted command on the synthesized line', () => {
    expect(renderHelp('nosuch', new CommandSpec({}))).toContain('Usage: nosuch\n')
  })

  it('does not reach a listed name rendered in another dialect', () => {
    const rendered = renderHelp('grep', new CommandSpec({}), [], UsageStyle.CLAP)
    expect(rendered).toContain('Usage: grep\n')
    expect(rendered).not.toContain('PATTERNS')
  })
})
