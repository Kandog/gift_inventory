"""Small helpers that keep the Python server's behaviour identical to the original JavaScript one."""
from __future__ import annotations

import math
import re
import uuid
from datetime import datetime, timedelta, timezone


class DomainError(Exception):
    """An error the user can fix. Sent to the client as {"error": message} with this HTTP status."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def new_id() -> str:
    return str(uuid.uuid4())


def now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def ms_to_iso(ms: int) -> str:
    """Like JavaScript's Date.toISOString(): 2026-11-24T15:04:05.000Z"""
    d = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=ms)
    return d.strftime('%Y-%m-%dT%H:%M:%S.') + f'{d.microsecond // 1000:03d}Z'


def now_iso() -> str:
    return ms_to_iso(now_ms())


_ISO_RE = re.compile(
    r'^(\d{4})-(\d{2})(?:-(\d{2}))?'
    r'(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$'
)


def parse_time_ms(value) -> int | None:
    """Like JavaScript's Date.parse() for ISO 8601 text: milliseconds since 1970, or None if unreadable.

    A date alone ("2026-11-24") is UTC midnight; a date and time without an offset is local time.
    """
    if not isinstance(value, str):
        return None
    m = _ISO_RE.match(value.strip())
    if not m:
        return None
    y, mo, d, hh, mi, ss, frac, tz = m.groups()
    try:
        if hh is None:
            dt = datetime(int(y), int(mo), int(d or 1), tzinfo=timezone.utc)
        else:
            micro = int((frac or '0')[:6].ljust(6, '0'))
            dt = datetime(int(y), int(mo), int(d or 1), int(hh), int(mi), int(ss or 0), micro)
            if tz is None:
                dt = dt.astimezone()  # naive = local time
            elif tz in ('Z', 'z'):
                dt = dt.replace(tzinfo=timezone.utc)
            else:
                sign = 1 if tz[0] == '+' else -1
                digits = tz[1:].replace(':', '')
                offset = timedelta(hours=int(digits[:2]), minutes=int(digits[2:]))
                dt = dt.replace(tzinfo=timezone(sign * offset))
    except (ValueError, OverflowError):
        return None
    return (dt - _EPOCH) // timedelta(milliseconds=1)


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


_NUM_RE = re.compile(r'^[+-]?(Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)$')
_RADIX_RE = re.compile(r'^0([xXoObB])([0-9a-fA-F]+)$')


def js_number(text) -> float:
    """Like JavaScript's Number(text) for strings: '' is 0, unreadable text is NaN."""
    if text is None:
        return math.nan
    if isinstance(text, bool):
        return 1.0 if text else 0.0
    if isinstance(text, (int, float)):
        return float(text)
    s = str(text).strip()
    if s == '':
        return 0.0
    if _NUM_RE.match(s):
        return float(s.replace('Infinity', 'inf'))
    m = _RADIX_RE.match(s)
    if m:
        base = {'x': 16, 'o': 8, 'b': 2}[m.group(1).lower()]
        try:
            return float(int(m.group(2), base))
        except ValueError:
            return math.nan
    return math.nan


def is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def is_int(v) -> bool:
    """Like JavaScript's Number.isInteger()."""
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return True
    return isinstance(v, float) and math.isfinite(v) and v.is_integer()


def as_number(v):
    """Turns a whole float (from JSON, e.g. 2.0) into an int so it is stored and shown like JavaScript does."""
    if isinstance(v, float) and is_int(v):
        return int(v)
    return v


def round2(n: float):
    """Like Math.round(n * 100) / 100 in JavaScript (halves round up)."""
    return as_number(math.floor(n * 100 + 0.5) / 100)


def text(v) -> str:
    """A string field from a JSON body; anything else becomes ''."""
    return v if isinstance(v, str) else ''


def js_str(v) -> str:
    """Like JavaScript's String(v) for the cell values used in exports."""
    if v is None:
        return ''
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, float):
        if v.is_integer() and math.isfinite(v):
            return str(int(v))
        return repr(v)
    return str(v)
