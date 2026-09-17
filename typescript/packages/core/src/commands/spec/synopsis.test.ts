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

  it('replaces the synthesized line when handed in', () => {
    expect(renderHelp('grep', specOf('grep'), [], UsageStyle.ARGPARSE, SYNOPSES.grep)).toContain(
      'Usage: grep [OPTION]... PATTERNS [FILE]...\n',
    )
  })

  it('leaves a spec rendered without one on the synthesized line', () => {
    // The registration site hands the synopsis in only for the builtin's
    // own spec object, so a custom `grep` renders what its spec says.
    const rendered = renderHelp('grep', new CommandSpec({}))
    expect(rendered).toContain('Usage: grep\n')
    expect(rendered).not.toContain('PATTERNS')
  })
})
