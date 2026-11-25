"""Stock overview, alerts and Event reports for the dashboard."""
from __future__ import annotations

from .auth import list_devices
from .db import Db, get_setting
from .rules import event_closed_at, is_event_open, is_low_stock, resolve_event_id, stock_key
from .store import list_categories, list_events, list_gifts, list_locations, stock_map
from .util import now_iso, now_ms, parse_time_ms, round2

STALE_DEVICE_DAYS = 7
BACKUP_OVERDUE_DAYS = 2
DAY_MS = 86_400_000


def stock_overview(db: Db, include_archived: bool = False) -> dict:
    levels = stock_map(db)
    locations = list_locations(db)
    categories = {c['id']: c['name'] for c in list_categories(db)}
    rows = []
    for g in list_gifts(db):
        if g['archived'] and not include_archived:
            continue
        by_location = {}
        total = 0
        negative = False
        for loc in locations:
            pieces = levels.get(stock_key(g['id'], loc['id']), 0)
            by_location[loc['id']] = pieces
            total += pieces
            if pieces < 0:
                negative = True
        rows.append(
            {
                'giftId': g['id'],
                'name': g['name'],
                'category': categories.get(g['categoryId']) if g['categoryId'] else None,
                'archived': g['archived'],
                'byLocation': by_location,
                'total': total,
                'unitCost': g['unitCost'],
                'value': round2(g['unitCost'] * max(total, 0)) if g['unitCost'] is not None else None,
                'lowStockThreshold': g['lowStockThreshold'],
                'low': is_low_stock(total, g['lowStockThreshold']),
                'negative': negative,
            }
        )
    total_value = round2(sum(r['value'] or 0 for r in rows))
    shown = [l for l in locations if not l['archived'] or any(r['byLocation'].get(l['id']) for r in rows)]
    return {'locations': shown, 'rows': rows, 'totalValue': total_value}


def alerts(db: Db) -> dict:
    ov = stock_overview(db)
    loc_name = {l['id']: l['name'] for l in ov['locations']}
    low = [
        {'giftId': r['giftId'], 'name': r['name'], 'total': r['total'], 'threshold': r['lowStockThreshold']}
        for r in ov['rows']
        if r['low']
    ]
    negative = [
        {'giftId': r['giftId'], 'name': r['name'], 'locationId': lid, 'location': loc_name.get(lid, '?'), 'pieces': p}
        for r in ov['rows']
        for lid, p in r['byLocation'].items()
        if p < 0
    ]
    stale_cutoff = now_ms() - STALE_DEVICE_DAYS * DAY_MS
    stale = [
        {'id': d['id'], 'name': d['name'], 'lastSyncAt': d['lastSyncAt'], 'lastUserName': d['lastUserName']}
        for d in list_devices(db)
        if not d['revokedAt'] and (d['lastSyncAt'] is None or (parse_time_ms(d['lastSyncAt']) or 0) < stale_cutoff)
    ]
    last = get_setting(db, 'backup.lastSuccessAt')
    overdue = not last or (parse_time_ms(last) or 0) < now_ms() - BACKUP_OVERDUE_DAYS * DAY_MS
    return {
        'lowStock': low,
        'negativeStock': negative,
        'staleDevices': stale,
        'backup': {
            'lastSuccessAt': last,
            'path': get_setting(db, 'backup.path'),
            'overdue': overdue,
            'lastError': get_setting(db, 'backup.lastError'),
        },
    }


def _live_issues(db: Db):
    return db.all(
        """SELECT e.id, e.gift_id, e.quantity, e.event_id, e.synced_at, e.occurred_at FROM entries e
           WHERE e.kind = 'issue' AND NOT EXISTS (SELECT 1 FROM voids v WHERE v.entry_id = e.id)"""
    )


def event_summaries(db: Db) -> list[dict]:
    """One line per surviving (not merged-away) Event with totals."""
    events = list_events(db)
    by_id = {e['id']: e for e in events}
    gifts = {g['id']: g for g in list_gifts(db)}
    totals: dict[str, dict] = {}
    for i in _live_issues(db):
        target = resolve_event_id(i['event_id'], by_id)
        if not target:
            continue
        t = totals.setdefault(target, {'pieces': 0, 'cost': 0})
        t['pieces'] += i['quantity']
        t['cost'] += ((gifts.get(i['gift_id']) or {}).get('unitCost') or 0) * i['quantity']
    now = now_iso()
    return [
        {
            **e,
            'open': is_event_open(e, now),
            'piecesIssued': totals.get(e['id'], {}).get('pieces', 0),
            'cost': round2(totals.get(e['id'], {}).get('cost', 0)),
            'mergedFrom': [x['name'] for x in events if x['mergedIntoId'] == e['id']],
        }
        for e in events
        if not e['mergedIntoId']
    ]


def event_report(db: Db, event_id: str) -> dict | None:
    events = list_events(db)
    by_id = {e['id']: e for e in events}
    target = resolve_event_id(event_id, by_id)
    ev = by_id.get(target) if target else None
    if not ev:
        return None
    closed_at = event_closed_at(ev)
    gifts = {g['id']: g for g in list_gifts(db)}
    lines: dict[str, dict] = {}
    late = 0
    for i in _live_issues(db):
        if resolve_event_id(i['event_id'], by_id) != ev['id']:
            continue
        g = gifts.get(i['gift_id'])
        line = lines.get(i['gift_id']) or {
            'giftId': i['gift_id'],
            'name': g['name'] if g else '?',
            'pieces': 0,
            'unitCost': g['unitCost'] if g else None,
            'cost': 0,
        }
        line['pieces'] += i['quantity']
        line['cost'] = round2(line['pieces'] * (line['unitCost'] or 0))
        lines[i['gift_id']] = line
        if closed_at and (parse_time_ms(i['synced_at']) or 0) > (parse_time_ms(closed_at) or 0):
            late += 1
    ordered = sorted(lines.values(), key=lambda l: -l['pieces'])
    return {
        'event': {**ev, 'open': is_event_open(ev, now_iso()), 'closedAtEffective': closed_at},
        'lines': ordered,
        'totalPieces': sum(l['pieces'] for l in ordered),
        'totalCost': round2(sum(l['cost'] for l in ordered)),
        'lateSyncedIssues': late,
    }
