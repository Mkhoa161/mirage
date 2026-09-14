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
import { strftime } from '../commands/builtin/utils/strftime.ts'
import {
  LOCAL_ZONE,
  UTC_ZONE,
  numericAbbreviation,
  posixZone,
  resolveTz,
  transitionAt,
  tzAbbreviation,
  zoneFromEnv,
} from './timezone.ts'
import { TZ_ABBREVS } from './tz_abbrevs.ts'

// Pinned against GNU date 9.x on debian:stable-slim with tzdata installed:
// `TZ=<spec> date -d @<epoch> '+%Y-%m-%d %H:%M:%S %z %Z'`. %Z is tzdata's
// abbreviation, read from the generated table.
const EPOCH = 0
const SUMMER = 1751328000
const WINTER = 1735689600

function render(spec: string, epoch: number, fmt = '%Y-%m-%d %H:%M:%S %z %Z'): string {
  return strftime(new Date(epoch * 1000), fmt, resolveTz(spec))
}

describe('resolveTz: tzdata names', () => {
  it.each([
    ['UTC', EPOCH, '1970-01-01 00:00:00 +0000 UTC'],
    ['Asia/Hong_Kong', EPOCH, '1970-01-01 08:00:00 +0800 HKT'],
    ['America/Los_Angeles', EPOCH, '1969-12-31 16:00:00 -0800 PST'],
    ['America/Los_Angeles', SUMMER, '2025-06-30 17:00:00 -0700 PDT'],
    [':Asia/Tokyo', EPOCH, '1970-01-01 09:00:00 +0900 JST'],
    ['Asia/Kolkata', EPOCH, '1970-01-01 05:30:00 +0530 IST'],
    ['Etc/GMT+5', EPOCH, '1969-12-31 19:00:00 -0500 -05'],
    ['EST5EDT', SUMMER, '2025-06-30 20:00:00 -0400 EDT'],
    ['EST5EDT', WINTER, '2024-12-31 19:00:00 -0500 EST'],
    ['Europe/London', EPOCH, '1970-01-01 01:00:00 +0100 BST'],
    ['Europe/London', WINTER, '2025-01-01 00:00:00 +0000 GMT'],
    ['Australia/Sydney', SUMMER, '2025-07-01 10:00:00 +1000 AEST'],
    ['Australia/Sydney', WINTER, '2025-01-01 11:00:00 +1100 AEDT'],
    ['Asia/Singapore', EPOCH, '1970-01-01 07:30:00 +0730 +0730'],
    ['Asia/Singapore', SUMMER, '2025-07-01 08:00:00 +0800 +08'],
    ['America/Sao_Paulo', EPOCH, '1969-12-31 21:00:00 -0300 -03'],
    ['Europe/Moscow', 1340000000, '2012-06-18 10:13:20 +0400 MSK'],
  ])('%s at @%d', (spec, epoch, expected) => {
    expect(render(spec, epoch)).toBe(expected)
  })
})

describe('resolveTz: POSIX strings', () => {
  it.each([
    ['UTC0', EPOCH, '1970-01-01 00:00:00 +0000 UTC'],
    ['EST5', EPOCH, '1969-12-31 19:00:00 -0500 EST'],
    ['JST-9', EPOCH, '1970-01-01 09:00:00 +0900 JST'],
    ['<+0530>-5:30', EPOCH, '1970-01-01 05:30:00 +0530 +0530'],
    ['CET-1CEST,M3.5.0,M10.5.0/3', EPOCH, '1970-01-01 01:00:00 +0100 CET'],
    ['CET-1CEST,M3.5.0,M10.5.0/3', SUMMER, '2025-07-01 02:00:00 +0200 CEST'],
    ['CET-1CEST,M3.5.0,M10.5.0/3', WINTER, '2025-01-01 01:00:00 +0100 CET'],
    ['CET-1CEST,J60,J300/1', SUMMER, '2025-07-01 02:00:00 +0200 CEST'],
    ['CET-1CEST,59,299', SUMMER, '2025-07-01 02:00:00 +0200 CEST'],
    ['EST5EDT,M3.2.0,M11.1.0', SUMMER, '2025-06-30 20:00:00 -0400 EDT'],
    ['AEST-10AEDT,M10.1.0,M4.1.0/3', EPOCH, '1970-01-01 11:00:00 +1100 AEDT'],
    ['AEST-10AEDT,M10.1.0,M4.1.0/3', SUMMER, '2025-07-01 10:00:00 +1000 AEST'],
    ['AEST-10AEDT,M10.1.0,M4.1.0/3', WINTER, '2025-01-01 11:00:00 +1100 AEDT'],
    ['XXX3YYY', EPOCH, '1969-12-31 21:00:00 -0300 XXX'],
    ['XXX3YYY', SUMMER, '2025-06-30 22:00:00 -0200 YYY'],
  ])('%s at @%d', (spec, epoch, expected) => {
    expect(render(spec, epoch)).toBe(expected)
  })
})

describe('resolveTz: glibc fallbacks', () => {
  // glibc reads an unknown name as a POSIX string with no offset, so it
  // renders UTC under that name; a name under three letters is refused
  // and leaves %Z empty; an empty TZ is UTC (glibc spells that one
  // `Universal`, the one abbreviation here that differs).
  it.each([
    ['Bogus/Zone', '1970-01-01 00:00:00 +0000 Bogus'],
    ['XYZ', '1970-01-01 00:00:00 +0000 XYZ'],
    ['Z', '1970-01-01 00:00:00 +0000 '],
    ['', '1970-01-01 00:00:00 +0000 UTC'],
  ])('%s', (spec, expected) => {
    expect(render(spec, EPOCH)).toBe(expected)
  })
})

describe('zoneFromEnv', () => {
  it('reads only the command environment', () => {
    expect(zoneFromEnv(null)).toBeNull()
    expect(zoneFromEnv(undefined)).toBeNull()
    expect(zoneFromEnv({})).toBeNull()
    expect(zoneFromEnv({ TZ: 'UTC' })?.parts(new Date(0)).abbrev).toBe('UTC')
    expect(zoneFromEnv({ TZ: 'Asia/Hong_Kong' })?.parts(new Date(0)).hour).toBe(8)
  })
})

describe('Zone.fromWall', () => {
  const cet = resolveTz('CET-1CEST,M3.5.0,M10.5.0/3')
  const berlin = resolveTz('Europe/Berlin')
  const wall = { year: 2025, month: 9, day: 26, hour: 2, minute: 30, second: 0, ms: 0 }
  const gap = { year: 2025, month: 2, day: 30, hour: 2, minute: 30, second: 0, ms: 0 }

  it('resolves a repeated hour to standard time, as glibc mktime does', () => {
    // 02:30 on the night CEST ends is the later instant, 02:30 CET.
    expect(cet.fromWall(wall).getTime() / 1000).toBe(1761442200)
    expect(berlin.fromWall(wall).getTime() / 1000).toBe(1761442200)
  })

  it('reads a skipped hour under the standard offset', () => {
    // No instant shows 02:30 the night CEST starts; the reading lands an
    // hour on, which is how a caller tells it was skipped.
    expect(cet.parts(cet.fromWall(gap)).hour).toBe(3)
    expect(berlin.parts(berlin.fromWall(gap)).hour).toBe(3)
  })

  it('round-trips an ordinary wall clock in every zone shape', () => {
    const p = { year: 2026, month: 8, day: 3, hour: 5, minute: 7, second: 9, ms: 0 }
    for (const zone of [
      UTC_ZONE,
      LOCAL_ZONE,
      cet,
      berlin,
      resolveTz('JST-9'),
      resolveTz('Bogus'),
    ]) {
      const shown = zone.parts(zone.fromWall(p))
      expect([shown.year, shown.month, shown.day, shown.hour, shown.minute, shown.second]).toEqual([
        2026, 8, 3, 5, 7, 9,
      ])
    }
  })

  it('carries an overflowing day into the next month', () => {
    const p = { year: 2026, month: 0, day: 32, hour: 0, minute: 0, second: 0, ms: 0 }
    expect(UTC_ZONE.parts(UTC_ZONE.fromWall(p)).month).toBe(1)
    expect(berlin.parts(berlin.fromWall(p)).month).toBe(1)
  })
})

describe('transitionAt', () => {
  const at = (rule: Parameters<typeof transitionAt>[0], year: number): string =>
    new Date(transitionAt(rule, year)).toISOString()
  const base = { month: 0, week: 0, weekday: 0, day: 0, seconds: 7200 }

  it('places M, J and bare-day rules', () => {
    expect(at({ ...base, kind: 'M', month: 3, week: 5, weekday: 0 }, 2025)).toBe(
      '2025-03-30T02:00:00.000Z',
    )
    expect(at({ ...base, kind: 'M', month: 11, week: 1, weekday: 0 }, 2025)).toBe(
      '2025-11-02T02:00:00.000Z',
    )
    // J60 is March 1 whatever the year: February 29 is never counted.
    expect(at({ ...base, kind: 'J', day: 60 }, 2024)).toBe('2024-03-01T02:00:00.000Z')
    expect(at({ ...base, kind: 'J', day: 60 }, 2025)).toBe('2025-03-01T02:00:00.000Z')
    // A bare day is zero-based and counts February 29.
    expect(at({ ...base, kind: 'D', day: 59 }, 2024)).toBe('2024-02-29T02:00:00.000Z')
    expect(at({ ...base, kind: 'D', day: 59 }, 2025)).toBe('2025-03-01T02:00:00.000Z')
    expect(at({ ...base, kind: 'M', month: 10, week: 5, weekday: 0, seconds: 10800 }, 2025)).toBe(
      '2025-10-26T03:00:00.000Z',
    )
  })
})

describe('posixZone', () => {
  it('applies the US rule when a DST name comes without one', () => {
    const zone = posixZone('XXX3YYY')
    expect(zone.parts(new Date(SUMMER * 1000)).abbrev).toBe('YYY')
    expect(zone.parts(new Date(WINTER * 1000)).abbrev).toBe('XXX')
  })

  it('falls back to UTC with no abbreviation on a malformed rule', () => {
    expect(strftime(new Date(0), '%z|%Z', posixZone('CET-1CEST,bogus'))).toBe('+0000|')
  })
})

describe('tzAbbreviation: the table the generator wrote from zoneinfo', () => {
  it.each([
    [0, '+00'],
    [28800, '+08'],
    [-10800, '-03'],
    [19800, '+0530'],
    [31500, '+0845'],
    [-34200, '-0930'],
  ])('spells %d as %s', (offset, expected) => {
    expect(numericAbbreviation(offset)).toBe(expected)
  })

  it('reads a lettered name by offset and spells out the rest', () => {
    expect(tzAbbreviation('Asia/Hong_Kong', 28800)).toBe('HKT')
    expect(tzAbbreviation('Asia/Hong_Kong', 32400)).toBe('HKST')
    expect(tzAbbreviation('Europe/London', 0)).toBe('GMT')
    expect(tzAbbreviation('Europe/London', 3600)).toBe('BST')
    expect(tzAbbreviation('Asia/Singapore', 28800)).toBe('+08')
    expect(tzAbbreviation('Nowhere/Zone', -10800)).toBe('-03')
  })

  it('has no row for a zone tzdata names by its offset', () => {
    expect(TZ_ABBREVS['Asia/Singapore']).toBeUndefined()
    expect(TZ_ABBREVS['America/Sao_Paulo']).toBeUndefined()
    expect(TZ_ABBREVS['Etc/GMT+5']).toBeUndefined()
  })

  it('keeps the later of two names at one offset', () => {
    // Moscow's +04 was MSD in summers before 2011 and MSK from 2011 to 2014.
    expect(tzAbbreviation('Europe/Moscow', 14400)).toBe('MSK')
  })
})
