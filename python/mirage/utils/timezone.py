# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

TZ_VAR = "TZ"

# A POSIX TZ name: `<...>` quotes any run of letters, digits and signs
# (`<+0530>`), and a bare name is three or more letters (`EST`, `CEST`).
_NAME_RE = re.compile(r"<([+\-0-9A-Za-z]+)>|([A-Za-z]{3,})")
# A POSIX offset or rule time: `[+-]h[h[h]][:mm[:ss]]`.
_OFFSET_RE = re.compile(r"([+-]?)(\d{1,3})(?::(\d{1,2}))?(?::(\d{1,2}))?")
_RULE_RE = re.compile(r"M(\d{1,2})\.(\d)\.(\d)|J(\d{1,3})|(\d{1,3})")
_HOUR = 3600
_DAY = timedelta(days=1)
_WEEK = timedelta(days=7)
# The rule glibc applies when a DST name comes with no `,rule`: the US
# transitions, second Sunday of March and first Sunday of November.
_DEFAULT_RULES = "M3.2.0,M11.1.0"
# The window zone_abbreviations samples: tzdata's post-1970 rules, up to
# the 32-bit horizon every zone's rules are laid out to.
_ABBREV_SAMPLE_START = datetime(1970, 1, 1, tzinfo=timezone.utc)
_ABBREV_SAMPLE_END = datetime(2038, 1, 1, tzinfo=timezone.utc)


@dataclass(frozen=True, slots=True)
class TransitionRule:
    """One POSIX DST transition, ``Mm.w.d``, ``Jn`` or ``n``, with the
    local time of day it happens at.

    Args:
        kind (str): ``M`` for month/week/weekday, ``J`` for a Julian
            day that never counts February 29, ``D`` for a zero-based
            day of the year that does.
        month (int): the month for an ``M`` rule, 1 to 12.
        week (int): the week for an ``M`` rule, 1 to 5, where 5 is the
            last such weekday of the month.
        weekday (int): the weekday for an ``M`` rule, 0 for Sunday.
        day (int): the day for a ``J`` (1 to 365) or ``D`` (0 to 365)
            rule.
        seconds (int): the time of day, in seconds, which POSIX lets run
            past a day in either direction (``/-1``, ``/25``).
    """

    kind: str
    month: int = 0
    week: int = 0
    weekday: int = 0
    day: int = 0
    seconds: int = 2 * _HOUR

    def at(self, year: int) -> datetime:
        """The transition's wall-clock moment in ``year``.

        Args:
            year (int): the calendar year.
        """
        if self.kind == "M":
            first = datetime(year, self.month, 1)
            # Python counts Monday as 0; POSIX counts Sunday as 0.
            ahead = (self.weekday - (first.weekday() + 1)) % 7
            date = first + timedelta(days=ahead) + _WEEK * (self.week - 1)
            while date.month != self.month:
                date -= _WEEK
        elif self.kind == "J":
            date = datetime(year, 1, 1) + timedelta(days=self.day - 1)
            leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
            if leap and self.day >= 60:
                date += _DAY
        else:
            date = datetime(year, 1, 1) + timedelta(days=self.day)
        return date + timedelta(seconds=self.seconds)


class PosixZone(tzinfo):
    """A zone read from a POSIX TZ string with a DST half
    (``CET-1CEST,M3.5.0,M10.5.0/3``), the way glibc reads one.

    The two offsets and the two rules decide everything: an instant is
    in DST when it lies between the start transition, given in standard
    wall time, and the end transition, given in DST wall time, with the
    window wrapping the year in the southern hemisphere. A wall clock
    that two instants share (the hour repeated at the end of DST)
    resolves to the first of them unless ``fold`` says otherwise, and
    one no instant shows (the hour skipped at its start) reads under
    the standard offset, which are Python's own conventions for a
    ``tzinfo``.

    Args:
        std (str): the standard-time abbreviation.
        std_offset (timedelta): the standard offset from UTC.
        dst (str): the daylight-time abbreviation.
        dst_offset (timedelta): the daylight offset from UTC.
        start (TransitionRule): when DST starts, in standard wall time.
        end (TransitionRule): when DST ends, in daylight wall time.
    """

    def __init__(self, std: str, std_offset: timedelta, dst: str,
                 dst_offset: timedelta, start: TransitionRule,
                 end: TransitionRule) -> None:
        self._std = std
        self._std_offset = std_offset
        self._dst = dst
        self._dst_offset = dst_offset
        self._start = start
        self._end = end

    def _in_dst(self, utc: datetime) -> bool:
        """Whether DST is in effect at a naive UTC moment.

        Args:
            utc (datetime): the moment, naive, on the UTC clock.
        """
        year = (utc + self._std_offset).year
        start = self._start.at(year) - self._std_offset
        end = self._end.at(year) - self._dst_offset
        if start < end:
            return start <= utc < end
        return not end <= utc < start

    def _offset_for(self, dt: datetime) -> timedelta:
        """The offset a wall-clock reading resolves to.

        Args:
            dt (datetime): the wall clock, whose ``fold`` picks the later
                of two instants sharing it.
        """
        wall = dt.replace(tzinfo=None)
        as_std = not self._in_dst(wall - self._std_offset)
        as_dst = self._in_dst(wall - self._dst_offset)
        if as_dst and (not as_std or dt.fold == 0):
            return self._dst_offset
        return self._std_offset

    def utcoffset(self, dt: datetime | None) -> timedelta:
        if dt is None:
            return self._std_offset
        return self._offset_for(dt)

    def dst(self, dt: datetime | None) -> timedelta:
        if dt is None or self._offset_for(dt) == self._std_offset:
            return timedelta(0)
        return self._dst_offset - self._std_offset

    def tzname(self, dt: datetime | None) -> str:
        if dt is not None and self._offset_for(dt) == self._dst_offset:
            return self._dst
        return self._std

    def fromutc(self, dt: datetime) -> datetime:
        utc = dt.replace(tzinfo=None)
        in_dst = self._in_dst(utc)
        wall = utc + (self._dst_offset if in_dst else self._std_offset)
        # The second reading of a repeated hour: a standard-time wall
        # clock that would also have resolved as daylight time.
        fold = int(not in_dst and self._in_dst(wall - self._dst_offset))
        return wall.replace(tzinfo=self, fold=fold)

    def __repr__(self) -> str:
        return (f"PosixZone({self._std!r}, {self._std_offset!r}, "
                f"{self._dst!r}, {self._dst_offset!r})")


def zone_from_env(env: Mapping[str, str] | None) -> tzinfo | None:
    """The zone a command environment's ``TZ`` names.

    None when ``TZ`` is unset (or there is no environment), which means
    the host's local zone, the way a naive ``datetime`` does. The value
    is read from the command's own environment, never from the process
    (``os.environ``, ``time.tzset``), so two workspaces running at once
    each see their own ``TZ`` and neither moves the host's clock.

    Args:
        env (Mapping[str, str] | None): the command environment.
    """
    if env is None:
        return None
    spec = env.get(TZ_VAR)
    if spec is None:
        return None
    return resolve_tz(spec)


def resolve_tz(spec: str) -> tzinfo:
    """The zone a ``TZ`` value names, read as glibc's ``tzset`` reads it.

    A leading colon is dropped. An empty value is UTC. A name tzdata
    knows (``Asia/Hong_Kong``, ``UTC``, ``EST5EDT``) is that zone.
    Anything else is a POSIX TZ string (``UTC0``, ``JST-9``,
    ``<+0530>-5:30``, ``CET-1CEST,M3.5.0,M10.5.0/3``), where a bare name
    with no offset is UTC under that name, which is how glibc renders
    ``TZ=Bogus/Zone`` (``+0000 Bogus``), and a name shorter than three
    letters is refused, leaving ``%Z`` empty.

    Args:
        spec (str): the value of ``TZ``.
    """
    name = spec[1:] if spec.startswith(":") else spec
    if not name:
        return timezone.utc
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return posix_zone(name)


def _read_name(spec: str, pos: int) -> tuple[str, int]:
    """Read a POSIX TZ name at ``pos``: the name and the position after
    it, or an empty name and ``pos`` when none starts there.

    Args:
        spec (str): the TZ string.
        pos (int): where to read.
    """
    match = _NAME_RE.match(spec, pos)
    if match is None:
        return "", pos
    return match.group(1) or match.group(2), match.end()


def _read_seconds(spec: str, pos: int) -> tuple[int | None, int]:
    """Read a POSIX ``[+-]hh[:mm[:ss]]`` at ``pos`` as signed seconds, or
    None when none starts there.

    Args:
        spec (str): the TZ string.
        pos (int): where to read.
    """
    match = _OFFSET_RE.match(spec, pos)
    if match is None:
        return None, pos
    sign = -1 if match.group(1) == "-" else 1
    hours = int(match.group(2))
    minutes = int(match.group(3) or 0)
    seconds = int(match.group(4) or 0)
    return sign * (hours * _HOUR + minutes * 60 + seconds), match.end()


def _read_rule(text: str) -> TransitionRule | None:
    """Read one ``,rule`` clause, or None when it is malformed.

    Args:
        text (str): the clause without its leading comma.
    """
    match = _RULE_RE.match(text)
    if match is None:
        return None
    seconds = 2 * _HOUR
    pos = match.end()
    if text[pos:pos + 1] == "/":
        read, pos = _read_seconds(text, pos + 1)
        if read is None:
            return None
        seconds = read
    if pos != len(text):
        return None
    if match.group(1) is not None:
        return TransitionRule("M",
                              month=int(match.group(1)),
                              week=int(match.group(2)),
                              weekday=int(match.group(3)),
                              seconds=seconds)
    if match.group(4) is not None:
        return TransitionRule("J", day=int(match.group(4)), seconds=seconds)
    return TransitionRule("D", day=int(match.group(5)), seconds=seconds)


def posix_zone(spec: str) -> tzinfo:
    """The zone a POSIX TZ string names.

    The grammar is ``std[offset[dst[offset][,start[/time],end[/time]]]]``.
    POSIX counts an offset west of Greenwich as positive, so ``EST5`` is
    five hours behind UTC; a missing offset is zero, and a missing
    daylight offset is one hour ahead of standard. A string that is not
    a TZ string at all (no name, or a rule that does not parse) is UTC
    with no abbreviation, which is what glibc falls back to.

    Args:
        spec (str): the TZ string, colon already dropped.
    """
    std, pos = _read_name(spec, 0)
    if not std:
        return timezone(timedelta(0), "")
    west, pos = _read_seconds(spec, pos)
    std_offset = timedelta(seconds=-(west or 0))
    dst, pos = _read_name(spec, pos)
    if not dst:
        return timezone(std_offset, std)
    west, pos = _read_seconds(spec, pos)
    dst_offset = (timedelta(
        seconds=-west) if west is not None else std_offset +
                  timedelta(hours=1))
    rules = spec[pos + 1:] if spec[pos:pos + 1] == "," else _DEFAULT_RULES
    clauses = rules.split(",")
    start = _read_rule(clauses[0])
    end = _read_rule(clauses[1]) if len(clauses) == 2 else None
    if start is None or end is None:
        return timezone(timedelta(0), "")
    return PosixZone(std, std_offset, dst, dst_offset, start, end)


def numeric_abbreviation(offset: int) -> str:
    """The abbreviation tzdata gives an offset it has no letters for.

    Since 2017 tzdata names such a zone by its offset, ``+08``, ``-03``
    or ``+0530``, with minutes only when they are not zero.

    Args:
        offset (int): the UTC offset in seconds, east positive.
    """
    sign = "-" if offset < 0 else "+"
    hours, rest = divmod(abs(offset), _HOUR)
    minutes = rest // 60
    return f"{sign}{hours:02d}" + (f"{minutes:02d}" if minutes else "")


def zone_abbreviations(name: str,
                       step: timedelta = _DAY) -> list[tuple[int, str]]:
    """The lettered abbreviations a tzdata zone has carried since 1970.

    Sampled once per ``step`` from 1970 to 2038, which catches every
    daylight period (the shortest lasts weeks) and every change of
    standard time. An abbreviation that is only the offset spelled out
    (``+08``) is left out, since ``numeric_abbreviation`` rebuilds it;
    when one offset has carried two names (Moscow's ``MSD`` summers
    before 2011 and its ``MSK`` at the same offset after them), the
    later one wins. This is the table the TypeScript twin ships for
    ``%Z``, because Intl offers no tzdata names.

    Args:
        name (str): a tzdata zone name.
        step (timedelta): the sampling interval.

    Returns:
        list[tuple[int, str]]: ``(offset_seconds, abbreviation)`` pairs,
        sorted by offset.
    """
    zone = ZoneInfo(name)
    latest: dict[int, str] = {}
    at = _ABBREV_SAMPLE_START
    while at < _ABBREV_SAMPLE_END:
        local = at.astimezone(zone)
        delta = local.utcoffset()
        abbrev = local.tzname()
        if delta is not None and abbrev is not None:
            latest[int(delta.total_seconds())] = abbrev
        at += step
    return sorted((offset, abbrev) for offset, abbrev in latest.items()
                  if abbrev != numeric_abbreviation(offset))
