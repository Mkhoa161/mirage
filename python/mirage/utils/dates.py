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
from calendar import monthrange
from datetime import datetime, timedelta, timezone, tzinfo

_UNIT_SECONDS = {
    "sec": 1,
    "second": 1,
    "min": 60,
    "minute": 60,
    "hour": 3600,
    "day": 86400,
    "week": 604800,
}
_CALENDAR_UNITS = ("month", "year")
_NUMBER_UNIT_RE = re.compile(r"([+-]?\d+)([a-z]+)\Z")
_NUMBER_RE = re.compile(r"[+-]?\d+\Z")

_EPOCH_RE = re.compile(r"@\s*[+-]?\d+(?:\.\d+)?")


def _date_unit(word: str) -> str | None:
    unit = word.removesuffix("s") if word != "s" else word
    if unit in _UNIT_SECONDS or unit in _CALENDAR_UNITS:
        return unit
    return None


def _add_months(dt: datetime, count: int) -> datetime:
    total = dt.month - 1 + count
    year = dt.year + total // 12
    month = total % 12 + 1
    # GNU normalizes an overflowing day-of-month through mktime rather
    # than clamping: Jan 31 + 1 month is Mar 3, not Feb 28.
    days = monthrange(year, month)[1]
    day = dt.day
    if day > days:
        day -= days
        month += 1
        if month == 13:
            month = 1
            year += 1
    return dt.replace(year=year, month=month, day=day)


def _shift(dt: datetime, unit: str, count: int) -> datetime:
    """Displace a moment by ``count`` units, as gnulib does.

    Months and years move the calendar (``_add_months``); days and
    weeks move the calendar too, keeping the wall clock across a DST
    change, which Python's aware arithmetic already does; hours,
    minutes and seconds are exact, so they are added on the UTC
    timeline (``2025-03-29 12:00 CET 24 hours`` is ``13:00 CEST``).
    A naive moment has no zone to cross, so every unit is plain
    arithmetic there.

    Args:
        dt (datetime): the moment to displace.
        unit (str): a key of ``_UNIT_SECONDS`` or a calendar unit.
        count (int): how many units, signed.
    """
    if unit == "month":
        return _add_months(dt, count)
    if unit == "year":
        return _add_months(dt, 12 * count)
    delta = timedelta(seconds=_UNIT_SECONDS[unit] * count)
    if dt.tzinfo is None or unit in ("day", "week"):
        return dt + delta
    return (dt.astimezone(timezone.utc) + delta).astimezone(dt.tzinfo)


def _localize(dt: datetime, tz: tzinfo | None) -> datetime | None:
    """Place a parsed moment on the timeline the caller reads in.

    A moment carrying its own zone is converted; a naive one is read
    as a wall clock in ``tz``, or stays naive (host local) when there
    is none, which is how GNU reads ``-d '2026-01-01 00:00'`` under a
    ``TZ``. Two wall clocks a zone does not show once are read as
    glibc's mktime reads them: the hour repeated when DST ends is the
    later (standard-time) instant, and the hour skipped when it starts
    is no moment at all, GNU's ``invalid date``.

    Args:
        dt (datetime): the parsed moment.
        tz (tzinfo | None): the zone, None for the host's local zone.

    Returns:
        datetime | None: the moment, or None for a skipped wall clock.
    """
    if dt.tzinfo is not None:
        return dt.astimezone(tz)
    if tz is None:
        return dt
    placed = dt.replace(tzinfo=tz, fold=1)
    shown = placed.astimezone(timezone.utc).astimezone(tz)
    if shown.replace(tzinfo=None) != dt:
        return None
    return placed


def _apply_relative(base: datetime, words: list[str]) -> datetime | None:
    result = base
    # What `ago` would negate: the state before the last displacement plus
    # that displacement. Re-applying from the checkpoint (rather than
    # subtracting twice) keeps month normalization exact.
    checkpoint: tuple[datetime, str, int] | None = None
    i = 0
    while i < len(words):
        word = words[i].lower()
        if word in ("now", "today"):
            checkpoint = None
            i += 1
            continue
        if word in ("yesterday", "tomorrow"):
            days = -1 if word == "yesterday" else 1
            checkpoint = (result, "day", days)
            result = _shift(result, "day", days)
            i += 1
            continue
        if word in ("last", "next"):
            if i + 1 >= len(words):
                return None
            unit = _date_unit(words[i + 1].lower())
            if unit is None:
                return None
            count = -1 if word == "last" else 1
            checkpoint = (result, unit, count)
            result = _shift(result, unit, count)
            i += 2
            continue
        if word == "ago":
            if checkpoint is None:
                return None
            before, unit, count = checkpoint
            result = _shift(before, unit, -count)
            checkpoint = None
            i += 1
            continue
        sign = 1
        if word in ("+", "-"):
            sign = -1 if word == "-" else 1
            i += 1
            if i >= len(words):
                return None
            word = words[i].lower()
        combined = _NUMBER_UNIT_RE.match(word)
        if combined:
            unit = _date_unit(combined.group(2))
            if unit is None:
                return None
            count = int(combined.group(1)) * sign
            checkpoint = (result, unit, count)
            result = _shift(result, unit, count)
            i += 1
            continue
        if _NUMBER_RE.match(word):
            if i + 1 >= len(words):
                return None
            unit = _date_unit(words[i + 1].lower())
            if unit is None:
                return None
            count = int(word) * sign
            checkpoint = (result, unit, count)
            result = _shift(result, unit, count)
            i += 2
            continue
        unit = _date_unit(word)
        if unit is not None:
            checkpoint = (result, unit, sign)
            result = _shift(result, unit, sign)
            i += 1
            continue
        return None
    return result


def parse_date_expr(text: str,
                    *,
                    tz: tzinfo | None = None,
                    now: datetime | None = None) -> datetime | None:
    """Parse a GNU `date -d` expression, or None when it is invalid.

    Covers the forms agents actually type: ISO 8601 dates and datetimes
    (with or without zone), `@epoch`, and gnulib's relative grammar
    (`24 hours ago`, `yesterday`, `next month`, `-2 weeks`, an ISO date
    followed by displacements). A None return is the caller's cue for
    GNU's `date: invalid date '...'` refusal, never a silent fallback.

    Args:
        text (str): the -d argument as typed.
        tz (tzinfo | None): the zone the result is read and rendered
            in: UTC under ``-u``, the zone ``TZ`` names, or None for
            the host's local zone, which keeps the result naive.
        now (datetime | None): the current moment, injectable for tests.
    """
    raw = text.strip()
    if not raw:
        return None
    if raw.startswith("@"):
        # gnulib's epoch grammar (findutils 4.10): blanks, a sign, a
        # decimal count of seconds and a fraction with digits on both
        # sides; `@0x1`, `@1e2`, `@1.` and `@.5` are not dates, however
        # readily float() would take them.
        if _EPOCH_RE.fullmatch(raw) is None:
            return None
        epoch = float(raw[1:])
        return datetime.fromtimestamp(epoch, tz=tz)
    try:
        return _localize(datetime.fromisoformat(raw), tz)
    except ValueError:
        pass
    words = raw.split()
    if now is None:
        now = datetime.now(tz)
    base = now
    index = 0
    for take in (2, 1):
        if len(words) < take:
            continue
        try:
            prefix = _localize(datetime.fromisoformat(" ".join(words[:take])),
                               tz)
        except ValueError:
            continue
        if prefix is None:
            return None
        base = prefix
        index = take
        break
    return _apply_relative(base, words[index:])


def utc_date_folder(ts: float | None = None) -> str:
    t = (datetime.now(timezone.utc) if ts is None else datetime.fromtimestamp(
        ts, timezone.utc))
    return t.strftime("%Y-%m-%d")


def iso_timestamp(value: str | None) -> float | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def timestamp_iso(epoch: float | None) -> str | None:
    """Spell an epoch seconds value the way the setattr op reads times.

    The inverse of ``iso_timestamp``. A guest hands `os.utime` epoch
    floats and the op takes ISO text, so the conversion lives here
    rather than in each runtime surface.

    Args:
        epoch (float | None): seconds since the epoch, or None.

    Returns:
        str | None: UTC ISO text, or None when there is no time.
    """
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat()


def in_mtime_window(timestamp: float | None, mtime_min: float | None,
                    mtime_max: float | None) -> bool:
    if mtime_min is None and mtime_max is None:
        return True
    if timestamp is None:
        return False
    if mtime_min is not None and timestamp < mtime_min:
        return False
    if mtime_max is not None and timestamp > mtime_max:
        return False
    return True


def matches_mtime(value: str | None, mtime_min: float | None,
                  mtime_max: float | None) -> bool:
    return in_mtime_window(iso_timestamp(value), mtime_min, mtime_max)
