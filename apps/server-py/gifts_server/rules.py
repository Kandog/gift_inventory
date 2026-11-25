"""Domain rules, ported from packages/shared (the phone app uses the TypeScript originals).

Both must compute identical Stock Levels and make the same decisions (ADR 0001), so keep them in step.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .util import is_int, ms_to_iso, parse_time_ms

STAFF_VOID_WINDOW_MS = 10 * 60 * 1000
EVENT_AUTO_CLOSE_DAYS = 3
LABEL_PREFIX = 'GIFT:'

KINDS = {'count', 'receive', 'issue', 'transfer', 'writeoff'}


def gift_label_payload(gift_id: str) -> str:
    return f'{LABEL_PREFIX}{gift_id}'


def stock_key(gift_id: str, location_id: str) -> str:
    return f'{gift_id}|{location_id}'


def compute_stock_levels(entries: list[dict], voided_ids: set[str]) -> dict[str, int]:
    """Replays all non-Voided entries in the order they happened (time, then id).

    A Count replaces the level at its Location; Movements add or subtract. Levels may go negative.
    """
    levels: dict[str, int] = {}

    def add(gift_id, location_id, delta):
        key = stock_key(gift_id, location_id)
        levels[key] = levels.get(key, 0) + delta

    ordered = sorted(
        (e for e in entries if e['id'] not in voided_ids),
        key=lambda e: (parse_time_ms(e['occurredAt']) or 0, e['id']),
    )
    for e in ordered:
        kind, q = e['kind'], e['quantity']
        if kind == 'count':
            levels[stock_key(e['giftId'], e['locationId'])] = q
        elif kind == 'receive':
            add(e['giftId'], e['locationId'], q)
        elif kind in ('issue', 'writeoff'):
            add(e['giftId'], e['locationId'], -q)
        elif kind == 'transfer':
            add(e['giftId'], e['locationId'], -q)
            if e.get('toLocationId'):
                add(e['giftId'], e['toLocationId'], q)
    return levels


def to_stock_level_list(levels: dict[str, int]) -> list[dict]:
    out = []
    for key, pieces in levels.items():
        gift_id, _, location_id = key.partition('|')
        out.append({'giftId': gift_id, 'locationId': location_id, 'pieces': pieces})
    return out


def validate_entry(e: dict, gift_exists, location_exists, resolve_event) -> str | None:
    """Structural checks only. Never rejects for stock reasons (ADR 0001). Returns a reason, or None."""
    kind = e.get('kind')
    if kind not in KINDS:
        return f'Unknown entry kind "{kind}"'
    q = e.get('quantity')
    if not is_int(q):
        return 'Quantity must be a whole number of Pieces'
    if (q < 0) if kind == 'count' else (q <= 0):
        return 'Quantity cannot be negative' if kind == 'count' else 'Quantity must be more than zero'
    if parse_time_ms(e.get('occurredAt')) is None:
        return 'Unreadable time'
    if not gift_exists(e.get('giftId')):
        return 'Unknown Gift'
    if not location_exists(e.get('locationId')):
        return 'Unknown Location'

    to_loc = e.get('toLocationId')
    if kind == 'transfer':
        if not to_loc:
            return 'A Transfer needs a destination Location'
        if to_loc == e.get('locationId'):
            return 'A Transfer needs a different destination Location'
        if not location_exists(to_loc):
            return 'Unknown destination Location'
    elif to_loc:
        return 'Only a Transfer has a destination Location'

    event_id = e.get('eventId')
    if kind == 'issue':
        if not event_id:
            return 'An Issue needs an Event'
        if not resolve_event(event_id):
            return 'Unknown Event'
    elif event_id:
        return 'Only an Issue has an Event'
    return None


def can_void(user: dict, entry: dict, void_at: str) -> bool:
    """ADR 0003: Admins void anything; Staff void their own entries within 10 minutes."""
    if user['role'] == 'admin':
        return True
    if user['id'] != entry['userId']:
        return False
    elapsed = parse_time_ms(void_at) - parse_time_ms(entry['occurredAt'])
    return 0 <= elapsed <= STAFF_VOID_WINDOW_MS


def auto_close_at_for(end_date: str) -> str:
    """Local midnight at the end of the 3rd day after endDate."""
    y, m, d = (int(x) for x in end_date.split('-'))
    local = datetime(y, m, d) + timedelta(days=EVENT_AUTO_CLOSE_DAYS + 1)
    utc = local.astimezone().astimezone(timezone.utc)
    return ms_to_iso(int(utc.timestamp()) * 1000)


def event_closed_at(ev: dict) -> str | None:
    times = [t for t in (ev.get('closedAt'), ev.get('autoCloseAt')) if t]
    if not times:
        return None
    return min(times, key=lambda t: parse_time_ms(t) or 0)


def is_event_open(ev: dict, now: str) -> bool:
    if ev.get('mergedIntoId'):
        return False
    closed = event_closed_at(ev)
    return closed is None or parse_time_ms(now) < parse_time_ms(closed)


def resolve_event_id(event_id: str, events: dict[str, dict]) -> str | None:
    current = event_id
    for _ in range(50):
        ev = events.get(current)
        if not ev:
            return None
        if not ev.get('mergedIntoId'):
            return current
        current = ev['mergedIntoId']
    return None  # merge cycle; should never happen


def is_low_stock(total: int, threshold) -> bool:
    return threshold is not None and total <= threshold
