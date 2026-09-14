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

// The zone a command renders time in, read from its own environment's TZ
// the way glibc's tzset reads it, never from the process: two workspaces
// running at once each see their own TZ and neither moves the host's
// clock. Mirrors the Python mirage.utils.timezone.

import { TZ_ABBREVS } from './tz_abbrevs.ts'

export const TZ_VAR = 'TZ'

/** A wall-clock reading: the calendar fields a zone shows for an instant. */
export interface WallParts {
  year: number
  // 0 for January, as `Date` counts it.
  month: number
  day: number
  hour: number
  minute: number
  second: number
  ms: number
}

/** A wall-clock reading with the zone's offset and abbreviation at that instant. */
export interface ZoneParts extends WallParts {
  // 0 for Sunday.
  weekday: number
  // Seconds east of UTC.
  offsetSec: number
  abbrev: string
}

/**
 * A time zone: the wall clock it shows for an instant, and the instant its
 * wall clock reads as. `Date` has no zone of its own, so every rendering
 * (`strftime`) and every reading (`parseDateExpr`) goes through one of
 * these rather than through a `utc` flag.
 */
export interface Zone {
  parts(dt: Date): ZoneParts
  /**
   * The instant whose wall clock reads `p`. A wall clock two instants share
   * (the hour repeated when DST ends) resolves to the later one, as glibc's
   * mktime resolves it; one no instant shows (the hour skipped when DST
   * starts) resolves under the standard offset, so a caller that must
   * refuse it compares `parts` of the result against `p`.
   */
  fromWall(p: WallParts): Date
}

const HOUR = 3600
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

// A POSIX TZ name: `<...>` quotes any run of letters, digits and signs
// (`<+0530>`), and a bare name is three or more letters (`EST`, `CEST`).
const NAME_RE = /<([+\-0-9A-Za-z]+)>|([A-Za-z]{3,})/y
// A POSIX offset or rule time: `[+-]h[h[h]][:mm[:ss]]`.
const OFFSET_RE = /([+-]?)(\d{1,3})(?::(\d{1,2}))?(?::(\d{1,2}))?/y
const RULE_RE = /M(\d{1,2})\.(\d)\.(\d)|J(\d{1,3})|(\d{1,3})/y
// The rule glibc applies when a DST name comes with no `,rule`: the US
// transitions, second Sunday of March and first Sunday of November.
const DEFAULT_RULES = 'M3.2.0,M11.1.0'

/**
 * A Date from wall-clock fields read as UTC. `Date.UTC` reads a year below
 * 100 as 1900 plus that year; the setters do not, so a year GNU and Python
 * accept as itself (`0042-01-01`) lands where it belongs. Overflowing
 * fields carry, so day 32 is the next month's first.
 */
export function utcFromWall(p: WallParts): Date {
  const d = new Date(0)
  d.setUTCFullYear(p.year, p.month, p.day)
  d.setUTCHours(p.hour, p.minute, p.second, p.ms)
  return d
}

function utcWall(dt: Date): WallParts & { weekday: number } {
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth(),
    day: dt.getUTCDate(),
    hour: dt.getUTCHours(),
    minute: dt.getUTCMinutes(),
    second: dt.getUTCSeconds(),
    ms: dt.getUTCMilliseconds(),
    weekday: dt.getUTCDay(),
  }
}

class UtcZone implements Zone {
  parts(dt: Date): ZoneParts {
    return { ...utcWall(dt), offsetSec: 0, abbrev: 'UTC' }
  }

  fromWall(p: WallParts): Date {
    return utcFromWall(p)
  }
}

// The host's zone, through the local `Date` getters. It carries no
// abbreviation: the runtime offers none short of Intl's default locale,
// and `%Z` has always rendered empty for a local time here.
class LocalZone implements Zone {
  parts(dt: Date): ZoneParts {
    return {
      year: dt.getFullYear(),
      month: dt.getMonth(),
      day: dt.getDate(),
      hour: dt.getHours(),
      minute: dt.getMinutes(),
      second: dt.getSeconds(),
      ms: dt.getMilliseconds(),
      weekday: dt.getDay(),
      offsetSec: -dt.getTimezoneOffset() * 60,
      abbrev: '',
    }
  }

  fromWall(p: WallParts): Date {
    const d = new Date(0)
    d.setFullYear(p.year, p.month, p.day)
    d.setHours(p.hour, p.minute, p.second, p.ms)
    return d
  }
}

/** One offset under one abbreviation: `UTC0`, `JST-9`, `<+0530>-5:30`. */
class FixedZone implements Zone {
  constructor(
    private readonly offsetSec: number,
    private readonly abbrev: string,
  ) {}

  parts(dt: Date): ZoneParts {
    const shown = utcWall(new Date(dt.getTime() + this.offsetSec * 1000))
    return { ...shown, offsetSec: this.offsetSec, abbrev: this.abbrev }
  }

  fromWall(p: WallParts): Date {
    return new Date(utcFromWall(p).getTime() - this.offsetSec * 1000)
  }
}

/**
 * The abbreviation tzdata gives an offset it has no letters for: `+08`,
 * `-03`, `+0530`, with minutes only when they are not zero.
 */
export function numericAbbreviation(offsetSec: number): string {
  const sign = offsetSec < 0 ? '-' : '+'
  const total = Math.abs(offsetSec)
  const hours = String(Math.floor(total / 3600)).padStart(2, '0')
  const minutes = Math.floor((total % 3600) / 60)
  return minutes === 0 ? `${sign}${hours}` : `${sign}${hours}${String(minutes).padStart(2, '0')}`
}

/**
 * The abbreviation tzdata gives `name` at `offsetSec`, which is what GNU
 * date prints for `%Z` and what Python's zoneinfo renders. Intl only
 * offers `GMT+8`, so the lettered names ship in TZ_ABBREVS (generated
 * from zoneinfo by scripts/gen_tz_abbrevs.py) and are looked up by the
 * offset Intl does report; an offset with no row is one tzdata spells
 * out (`+08`).
 */
export function tzAbbreviation(name: string, offsetSec: number): string {
  const row = TZ_ABBREVS[name]?.find(([offset]) => offset === offsetSec)
  return row === undefined ? numericAbbreviation(offsetSec) : row[1]
}

/**
 * A tzdata zone, read through Intl for its offsets and through
 * tzAbbreviation for its `%Z`, so `Asia/Hong_Kong` renders `HKT` here as
 * it does under GNU date and in the Python twin.
 */
class IntlZone implements Zone {
  private readonly format: Intl.DateTimeFormat

  constructor(private readonly name: string) {
    this.format = new Intl.DateTimeFormat('en-US', {
      timeZone: name,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
  }

  parts(dt: Date): ZoneParts {
    const fields: Record<string, string> = {}
    for (const part of this.format.formatToParts(dt)) fields[part.type] = part.value
    const wall: WallParts = {
      year: Number(fields.year),
      month: Number(fields.month) - 1,
      day: Number(fields.day),
      hour: Number(fields.hour) % 24,
      minute: Number(fields.minute),
      second: Number(fields.second),
      ms: dt.getUTCMilliseconds(),
    }
    const shown = utcFromWall(wall)
    const offsetSec = Math.round((shown.getTime() - dt.getTime()) / 1000)
    return {
      ...wall,
      weekday: shown.getUTCDay(),
      offsetSec,
      abbrev: tzAbbreviation(this.name, offsetSec),
    }
  }

  fromWall(p: WallParts): Date {
    const wall = utcFromWall(p).getTime()
    // The offset at the wall clock read as UTC is within a day of the
    // right one; the offset at that first guess is the right one except
    // across a transition, where the two guesses are the two readings.
    const first = wall - this.parts(new Date(wall)).offsetSec * 1000
    const second = wall - this.parts(new Date(first)).offsetSec * 1000
    for (const t of [Math.max(first, second), Math.min(first, second)]) {
      if (utcFromWall(this.parts(new Date(t))).getTime() === wall) return new Date(t)
    }
    return new Date(second)
  }
}

/**
 * One POSIX DST transition, `Mm.w.d`, `Jn` or `n`, with the local time of
 * day it happens at: `M` is month/week/weekday (week 5 is the last such
 * weekday, weekday 0 is Sunday), `J` a Julian day that never counts
 * February 29, `D` a zero-based day of the year that does. The time may
 * run past a day in either direction (`/-1`, `/25`), as POSIX allows.
 */
export interface TransitionRule {
  kind: 'M' | 'J' | 'D'
  month: number
  week: number
  weekday: number
  day: number
  seconds: number
}

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/** The transition's wall-clock moment in `year`, as ms of that wall clock read as UTC. */
export function transitionAt(rule: TransitionRule, year: number): number {
  const jan1 = utcFromWall({ year, month: 0, day: 1, hour: 0, minute: 0, second: 0, ms: 0 })
  let date: number
  if (rule.kind === 'M') {
    const first = utcFromWall({
      year,
      month: rule.month - 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
      ms: 0,
    })
    const ahead = (rule.weekday - first.getUTCDay() + 7) % 7
    date = first.getTime() + ahead * DAY_MS + (rule.week - 1) * WEEK_MS
    while (new Date(date).getUTCMonth() !== rule.month - 1) date -= WEEK_MS
  } else if (rule.kind === 'J') {
    date = jan1.getTime() + (rule.day - 1) * DAY_MS
    if (isLeap(year) && rule.day >= 60) date += DAY_MS
  } else {
    date = jan1.getTime() + rule.day * DAY_MS
  }
  return date + rule.seconds * 1000
}

/**
 * A zone read from a POSIX TZ string with a DST half
 * (`CET-1CEST,M3.5.0,M10.5.0/3`), the way glibc reads one. The two offsets
 * and the two rules decide everything: an instant is in DST when it lies
 * between the start transition, given in standard wall time, and the end
 * transition, given in DST wall time, with the window wrapping the year in
 * the southern hemisphere.
 */
class PosixZone implements Zone {
  constructor(
    private readonly std: string,
    private readonly stdOffsetSec: number,
    private readonly dst: string,
    private readonly dstOffsetSec: number,
    private readonly start: TransitionRule,
    private readonly end: TransitionRule,
  ) {}

  private inDst(utcMs: number): boolean {
    const year = new Date(utcMs + this.stdOffsetSec * 1000).getUTCFullYear()
    const start = transitionAt(this.start, year) - this.stdOffsetSec * 1000
    const end = transitionAt(this.end, year) - this.dstOffsetSec * 1000
    if (start < end) return start <= utcMs && utcMs < end
    return !(end <= utcMs && utcMs < start)
  }

  parts(dt: Date): ZoneParts {
    const inDst = this.inDst(dt.getTime())
    const offsetSec = inDst ? this.dstOffsetSec : this.stdOffsetSec
    const shown = utcWall(new Date(dt.getTime() + offsetSec * 1000))
    return { ...shown, offsetSec, abbrev: inDst ? this.dst : this.std }
  }

  fromWall(p: WallParts): Date {
    const wall = utcFromWall(p).getTime()
    const asStd = wall - this.stdOffsetSec * 1000
    const asDst = wall - this.dstOffsetSec * 1000
    // Standard time first: it is the later of two readings of a repeated
    // hour, which is the one glibc's mktime picks, and the reading a
    // skipped hour falls back to.
    if (!this.inDst(asStd)) return new Date(asStd)
    if (this.inDst(asDst)) return new Date(asDst)
    return new Date(asStd)
  }
}

export const UTC_ZONE: Zone = new UtcZone()
export const LOCAL_ZONE: Zone = new LocalZone()

/**
 * The zone a command environment's TZ names, or null when TZ is unset (or
 * there is no environment), which means the host's local zone.
 */
export function zoneFromEnv(env: Readonly<Record<string, string>> | null | undefined): Zone | null {
  const spec = env?.[TZ_VAR]
  if (spec === undefined) return null
  return resolveTz(spec)
}

/**
 * The zone a TZ value names, read as glibc's tzset reads it: a leading
 * colon is dropped; an empty value is UTC; a name tzdata knows
 * (`Asia/Hong_Kong`, `UTC`, `EST5EDT`) is that zone; anything else is a
 * POSIX TZ string (`UTC0`, `JST-9`, `<+0530>-5:30`,
 * `CET-1CEST,M3.5.0,M10.5.0/3`), where a bare name with no offset is UTC
 * under that name, which is how glibc renders `TZ=Bogus/Zone`
 * (`+0000 Bogus`), and a name shorter than three letters is refused,
 * leaving `%Z` empty.
 */
export function resolveTz(spec: string): Zone {
  const name = spec.startsWith(':') ? spec.slice(1) : spec
  if (name === '') return UTC_ZONE
  try {
    return new IntlZone(name)
  } catch (err) {
    if (!(err instanceof RangeError)) throw err
    return posixZone(name)
  }
}

function readName(spec: string, pos: number): [string, number] {
  NAME_RE.lastIndex = pos
  const m = NAME_RE.exec(spec)
  if (m === null) return ['', pos]
  return [m[1] ?? m[2] ?? '', NAME_RE.lastIndex]
}

// A POSIX `[+-]hh[:mm[:ss]]` at `pos` as signed seconds, or null when none starts there.
function readSeconds(spec: string, pos: number): [number | null, number] {
  OFFSET_RE.lastIndex = pos
  const m = OFFSET_RE.exec(spec)
  if (m === null) return [null, pos]
  const sign = m[1] === '-' ? -1 : 1
  const total = Number(m[2]) * HOUR + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)
  return [sign * total, OFFSET_RE.lastIndex]
}

function readRule(text: string): TransitionRule | null {
  RULE_RE.lastIndex = 0
  const m = RULE_RE.exec(text)
  if (m === null) return null
  let seconds = 2 * HOUR
  let pos = RULE_RE.lastIndex
  if (text[pos] === '/') {
    const [read, after] = readSeconds(text, pos + 1)
    if (read === null) return null
    seconds = read
    pos = after
  }
  if (pos !== text.length) return null
  const base = { month: 0, week: 0, weekday: 0, day: 0, seconds }
  if (m[1] !== undefined) {
    return { ...base, kind: 'M', month: Number(m[1]), week: Number(m[2]), weekday: Number(m[3]) }
  }
  if (m[4] !== undefined) return { ...base, kind: 'J', day: Number(m[4]) }
  return { ...base, kind: 'D', day: Number(m[5]) }
}

/**
 * The zone a POSIX TZ string names:
 * `std[offset[dst[offset][,start[/time],end[/time]]]]`. POSIX counts an
 * offset west of Greenwich as positive, so `EST5` is five hours behind
 * UTC; a missing offset is zero, and a missing daylight offset is one hour
 * ahead of standard. A string that is not a TZ string at all (no name, or
 * a rule that does not parse) is UTC with no abbreviation, which is what
 * glibc falls back to.
 */
export function posixZone(spec: string): Zone {
  const [std, afterStd] = readName(spec, 0)
  if (std === '') return new FixedZone(0, '')
  const [west, afterOffset] = readSeconds(spec, afterStd)
  const stdOffsetSec = -(west ?? 0)
  const [dst, afterDst] = readName(spec, afterOffset)
  if (dst === '') return new FixedZone(stdOffsetSec, std)
  const [dstWest, afterDstOffset] = readSeconds(spec, afterDst)
  const dstOffsetSec = dstWest !== null ? -dstWest : stdOffsetSec + HOUR
  const rules = spec[afterDstOffset] === ',' ? spec.slice(afterDstOffset + 1) : DEFAULT_RULES
  const clauses = rules.split(',')
  const start = readRule(clauses[0] ?? '')
  const end = clauses.length === 2 ? readRule(clauses[1] ?? '') : null
  if (start === null || end === null) return new FixedZone(0, '')
  return new PosixZone(std, stdOffsetSec, dst, dstOffsetSec, start, end)
}
