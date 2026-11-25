"""Gifts, Categories, Locations, Events, entries and Voids."""
from __future__ import annotations

import re

from .db import Db
from .rules import (
    auto_close_at_for,
    can_void,
    compute_stock_levels,
    resolve_event_id,
    to_stock_level_list,
    validate_entry,
)
from .util import DomainError, as_number, is_int, is_number, ms_to_iso, new_id, now_iso, parse_time_ms, text

# ---------- Categories & Locations ----------


def list_categories(db: Db) -> list[dict]:
    return [{'id': r['id'], 'name': r['name']} for r in db.all('SELECT id, name FROM categories ORDER BY name')]


def upsert_category_by_name(db: Db, name) -> str:
    clean = text(name).strip()
    if not clean:
        raise DomainError('Category name is required')
    row = db.one('SELECT id FROM categories WHERE name = ?', clean)
    if row:
        return row['id']
    cid = new_id()
    db.run('INSERT INTO categories (id, name) VALUES (?, ?)', cid, clean)
    return cid


def rename_category(db: Db, cid: str, name):
    if not text(name).strip():
        raise DomainError('Category name is required')
    db.run('UPDATE categories SET name = ? WHERE id = ?', text(name).strip(), cid)


def list_locations(db: Db) -> list[dict]:
    return [
        {'id': r['id'], 'name': r['name'], 'archived': bool(r['archived'])}
        for r in db.all('SELECT id, name, archived FROM locations ORDER BY name')
    ]


def create_location(db: Db, name) -> dict:
    clean = text(name).strip()
    if not clean:
        raise DomainError('Location name is required')
    if db.one('SELECT 1 FROM locations WHERE name = ?', clean):
        raise DomainError('A Location with that name already exists')
    lid = new_id()
    db.run('INSERT INTO locations (id, name) VALUES (?, ?)', lid, clean)
    return {'id': lid, 'name': clean, 'archived': False}


def update_location(db: Db, lid: str, patch: dict):
    if patch.get('name') is not None:
        if not text(patch['name']).strip():
            raise DomainError('Location name is required')
        db.run('UPDATE locations SET name = ? WHERE id = ?', text(patch['name']).strip(), lid)
    if patch.get('archived') is not None:
        db.run('UPDATE locations SET archived = ? WHERE id = ?', 1 if patch['archived'] else 0, lid)


def ensure_default_location(db: Db):
    """The single default Location so a fresh install works without setup."""
    if db.one('SELECT COUNT(*) AS n FROM locations')['n'] == 0:
        create_location(db, 'Storeroom')


# ---------- Gifts ----------


def list_gifts(db: Db) -> list[dict]:
    rows = db.all('SELECT * FROM gifts ORDER BY name')
    packs: dict[str, list] = {}
    for p in db.all('SELECT gift_id, name, pieces FROM gift_packs ORDER BY pieces'):
        packs.setdefault(p['gift_id'], []).append({'name': p['name'], 'pieces': p['pieces']})
    codes: dict[str, list] = {}
    for c in db.all('SELECT gift_id, code FROM gift_barcodes ORDER BY code'):
        codes.setdefault(c['gift_id'], []).append(c['code'])
    return [
        {
            'id': r['id'],
            'name': r['name'],
            'categoryId': r['category_id'],
            'unitCost': as_number(r['unit_cost']),
            'lowStockThreshold': r['low_stock_threshold'],
            'hasPhoto': bool(r['photo_file']),
            'archived': bool(r['archived']),
            'packs': packs.get(r['id'], []),
            'barcodes': codes.get(r['id'], []),
        }
        for r in rows
    ]


def get_gift(db: Db, gid: str) -> dict:
    for g in list_gifts(db):
        if g['id'] == gid:
            return g
    raise DomainError('Gift not found', 404)


def _check_gift_input(db: Db, inp: dict, gift_id: str | None):
    if not text(inp.get('name')).strip():
        raise DomainError('Gift name is required')
    cost = inp.get('unitCost')
    if cost is not None and not (is_number(cost) and cost >= 0):
        raise DomainError('Unit cost cannot be negative')
    thr = inp.get('lowStockThreshold')
    if thr is not None and not (is_int(thr) and thr >= 0):
        raise DomainError('Low-Stock Threshold must be a whole number of Pieces')
    for p in inp.get('packs') or []:
        if not isinstance(p, dict) or not text(p.get('name')).strip() or not is_int(p.get('pieces')) or p['pieces'] < 2:
            raise DomainError('Each Pack needs a name and at least 2 Pieces')
    for code in inp.get('barcodes') or []:
        owner = db.one('SELECT gift_id FROM gift_barcodes WHERE code = ?', text(code))
        if owner and owner['gift_id'] != gift_id:
            raise DomainError(f'Barcode {code} is already linked to another Gift')


def _write_gift_children(db: Db, gid: str, inp: dict):
    if inp.get('packs') is not None:
        db.run('DELETE FROM gift_packs WHERE gift_id = ?', gid)
        for p in inp['packs']:
            db.run('INSERT INTO gift_packs (gift_id, name, pieces) VALUES (?, ?, ?)', gid, p['name'].strip(), int(p['pieces']))
    if inp.get('barcodes') is not None:
        db.run('DELETE FROM gift_barcodes WHERE gift_id = ?', gid)
        seen = []
        for b in inp['barcodes']:
            c = text(b).strip()
            if c and c not in seen:
                seen.append(c)
        for c in seen:
            db.run('INSERT INTO gift_barcodes (code, gift_id) VALUES (?, ?)', c, gid)


def _num_or_none(v):
    return None if v is None else as_number(v)


def create_gift(db: Db, inp: dict) -> dict:
    inp = inp if isinstance(inp, dict) else {}
    _check_gift_input(db, inp, None)
    gid = new_id()
    with db.tx():
        db.run(
            'INSERT INTO gifts (id, name, category_id, unit_cost, low_stock_threshold, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            gid,
            inp['name'].strip(),
            inp.get('categoryId') or None,
            _num_or_none(inp.get('unitCost')),
            _num_or_none(inp.get('lowStockThreshold')),
            1 if inp.get('archived') else 0,
            now_iso(),
        )
        _write_gift_children(db, gid, inp)
    return get_gift(db, gid)


def update_gift(db: Db, gid: str, inp: dict) -> dict:
    inp = inp if isinstance(inp, dict) else {}
    get_gift(db, gid)
    _check_gift_input(db, inp, gid)
    with db.tx():
        db.run(
            'UPDATE gifts SET name = ?, category_id = ?, unit_cost = ?, low_stock_threshold = ?, archived = ? WHERE id = ?',
            inp['name'].strip(),
            inp.get('categoryId') or None,
            _num_or_none(inp.get('unitCost')),
            _num_or_none(inp.get('lowStockThreshold')),
            1 if inp.get('archived') else 0,
            gid,
        )
        _write_gift_children(db, gid, inp)
    return get_gift(db, gid)


def set_gift_photo(db: Db, gid: str, file: str | None):
    db.run('UPDATE gifts SET photo_file = ? WHERE id = ?', file, gid)


def get_gift_photo_file(db: Db, gid: str) -> str | None:
    row = db.one('SELECT photo_file FROM gifts WHERE id = ?', gid)
    return row['photo_file'] if row else None


def link_barcode(db: Db, gift_id: str, code: str):
    """Links an unknown Barcode scanned on a phone to an existing Gift."""
    gift = get_gift(db, gift_id)
    update_gift(db, gift_id, {**gift, 'barcodes': [*gift['barcodes'], code.strip()]})


# ---------- Events ----------


def _to_event(r) -> dict:
    return {
        'id': r['id'],
        'name': r['name'],
        'startDate': r['start_date'],
        'endDate': r['end_date'],
        'closedAt': r['closed_at'],
        'autoCloseAt': r['auto_close_at'],
        'mergedIntoId': r['merged_into_id'],
    }


def list_events(db: Db) -> list[dict]:
    return [_to_event(r) for r in db.all('SELECT * FROM events ORDER BY start_date DESC, name')]


def get_event(db: Db, eid: str) -> dict:
    row = db.one('SELECT * FROM events WHERE id = ?', eid)
    if not row:
        raise DomainError('Event not found', 404)
    return _to_event(row)


_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def _check_event_dates(start, end):
    if not (isinstance(start, str) and isinstance(end, str) and _DATE_RE.match(start) and _DATE_RE.match(end)):
        raise DomainError('Event dates must look like 2026-11-24')
    if parse_time_ms(start) is None or parse_time_ms(end) is None:
        raise DomainError('Event dates must look like 2026-11-24')
    if end < start:
        raise DomainError('An Event cannot end before it starts')


def create_event(db: Db, inp: dict, actor: dict) -> dict:
    inp = inp if isinstance(inp, dict) else {}
    if not text(inp.get('name')).strip():
        raise DomainError('Event name is required')
    _check_event_dates(inp.get('startDate'), inp.get('endDate'))
    eid = inp.get('id') or new_id()
    existing = db.one('SELECT * FROM events WHERE id = ?', eid)
    if existing:
        return _to_event(existing)  # idempotent re-sync from a phone
    db.run(
        'INSERT INTO events (id, name, start_date, end_date, auto_close_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        eid,
        inp['name'].strip(),
        inp['startDate'],
        inp['endDate'],
        auto_close_at_for(inp['endDate']),
        actor['id'],
        now_iso(),
    )
    return get_event(db, eid)


def update_event(db: Db, eid: str, inp: dict) -> dict:
    inp = inp if isinstance(inp, dict) else {}
    ev = get_event(db, eid)
    if not text(inp.get('name')).strip():
        raise DomainError('Event name is required')
    _check_event_dates(inp.get('startDate'), inp.get('endDate'))
    # Changing dates re-arms auto-close, unless an Admin had reopened it to stay open.
    auto_close = None if ev['autoCloseAt'] is None and ev['closedAt'] is None else auto_close_at_for(inp['endDate'])
    db.run(
        'UPDATE events SET name = ?, start_date = ?, end_date = ?, auto_close_at = ? WHERE id = ?',
        inp['name'].strip(),
        inp['startDate'],
        inp['endDate'],
        auto_close,
        eid,
    )
    return get_event(db, eid)


def close_event(db: Db, eid: str):
    get_event(db, eid)
    db.run('UPDATE events SET closed_at = ? WHERE id = ?', now_iso(), eid)


def reopen_event(db: Db, eid: str):
    get_event(db, eid)
    db.run('UPDATE events SET closed_at = NULL, auto_close_at = NULL WHERE id = ?', eid)


def merge_event(db: Db, from_id: str, into_id):
    """Folds from_id into into_id. Issues keep their original event_id and are resolved through the merge."""
    if from_id == into_id:
        raise DomainError('Cannot merge an Event into itself')
    get_event(db, from_id)
    get_event(db, text(into_id))
    events = {e['id']: e for e in list_events(db)}
    if resolve_event_id(into_id, events) == from_id:
        raise DomainError('That merge would create a loop')
    target = resolve_event_id(into_id, events)
    with db.tx():
        db.run('UPDATE events SET merged_into_id = ? WHERE id = ?', target, from_id)
        db.run('UPDATE events SET merged_into_id = ? WHERE merged_into_id = ?', target, from_id)


# ---------- Entries, Voids & stock ----------


def _to_entry(r) -> dict:
    return {
        'id': r['id'],
        'kind': r['kind'],
        'giftId': r['gift_id'],
        'locationId': r['location_id'],
        'toLocationId': r['to_location_id'],
        'quantity': r['quantity'],
        'eventId': r['event_id'],
        'note': r['note'],
        'userId': r['user_id'],
        'deviceId': r['device_id'],
        'occurredAt': r['occurred_at'],
    }


def stock_map(db: Db) -> dict[str, int]:
    if db.stock_cache is None:
        entries = [_to_entry(r) for r in db.all('SELECT * FROM entries')]
        voided = {r['entry_id'] for r in db.all('SELECT entry_id FROM voids')}
        db.stock_cache = compute_stock_levels(entries, voided)
    return db.stock_cache


def stock_levels(db: Db) -> list[dict]:
    return to_stock_level_list(stock_map(db))


def _lookups(db: Db):
    gifts = {r['id'] for r in db.all('SELECT id FROM gifts')}
    locations = {r['id'] for r in db.all('SELECT id FROM locations')}
    events = {e['id']: e for e in list_events(db)}
    return (
        lambda i: isinstance(i, str) and i in gifts,
        lambda i: isinstance(i, str) and i in locations,
        lambda i: resolve_event_id(i, events) if isinstance(i, str) else None,
    )


def _insert_entry(db: Db, e: dict, synced_at: str):
    ms = parse_time_ms(e['occurredAt'])
    note = e.get('note')
    db.run(
        """INSERT INTO entries (id, kind, gift_id, location_id, to_location_id, quantity, event_id, note, user_id, device_id, occurred_at, occurred_ms, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        e['id'],
        e['kind'],
        e['giftId'],
        e['locationId'],
        e.get('toLocationId') or None,
        int(e['quantity']),
        e.get('eventId') or None,
        (note.strip() or None) if isinstance(note, str) else None,
        e['userId'],
        e.get('deviceId'),
        ms_to_iso(ms),
        ms,
        synced_at,
    )


def get_entry(db: Db, eid) -> dict | None:
    row = db.one('SELECT * FROM entries WHERE id = ?', eid) if isinstance(eid, str) else None
    return _to_entry(row) if row else None


def apply_sync(db: Db, actor: dict, push: dict) -> dict:
    """Applies a batch from a phone (or the dashboard). Idempotent: re-sending the same ids is safe.

    Events first, then entries, then Voids, so a Void can refer to an entry in the same batch.
    """
    push = push if isinstance(push, dict) else {}
    result = {'accepted': [], 'rejected': []}
    synced_at = now_iso()

    def items(key):
        return [x if isinstance(x, dict) else {} for x in (push.get(key) or [])]

    try:
        with db.tx():
            for ev in items('events'):
                try:
                    with db.tx():
                        create_event(db, ev, actor)
                    result['accepted'].append(ev.get('id'))
                except DomainError as err:
                    result['rejected'].append({'id': ev.get('id'), 'reason': err.message})

            for link in items('barcodeLinks'):
                try:
                    code = text(link.get('code')).strip()
                    owner = db.one('SELECT gift_id FROM gift_barcodes WHERE code = ?', code)
                    if not owner or owner['gift_id'] != link.get('giftId'):
                        with db.tx():
                            link_barcode(db, text(link.get('giftId')), text(link.get('code')))
                    result['accepted'].append(link.get('id'))
                except DomainError as err:
                    result['rejected'].append({'id': link.get('id'), 'reason': err.message})

            gift_exists, location_exists, resolve_event = _lookups(db)
            for raw in items('entries'):
                # The server, not the phone, decides who and which Device made it.
                e = {**raw, 'userId': actor['id'], 'deviceId': actor.get('deviceId')}
                if not e.get('id'):
                    result['rejected'].append({'id': '', 'reason': 'Entry has no id'})
                    continue
                if get_entry(db, e['id']):
                    result['accepted'].append(e['id'])
                    continue
                problem = validate_entry(e, gift_exists, location_exists, resolve_event)
                if problem:
                    result['rejected'].append({'id': e['id'], 'reason': problem})
                    continue
                _insert_entry(db, e, synced_at)
                result['accepted'].append(e['id'])

            for v in items('voids'):
                problem = _apply_void(db, actor, v, synced_at)
                if problem:
                    result['rejected'].append({'id': v.get('id'), 'reason': problem})
                else:
                    result['accepted'].append(v.get('id'))
    finally:
        db.stock_cache = None
    return result


def _apply_void(db: Db, actor: dict, v: dict, synced_at: str) -> str | None:
    if not v.get('id') or not v.get('entryId'):
        return 'Void is missing its id or entry'
    if db.one('SELECT 1 FROM voids WHERE id = ? OR entry_id = ?', v['id'], v['entryId']):
        return None  # already voided
    entry = get_entry(db, v['entryId'])
    if not entry:
        return 'Unknown entry'
    if not text(v.get('reason')).strip():
        return 'A Void needs a reason'
    ms = parse_time_ms(v.get('occurredAt'))
    at = synced_at if ms is None else ms_to_iso(ms)
    if not can_void(actor, entry, at):
        return 'Staff can only Void within 10 minutes' if actor['id'] == entry['userId'] else 'Staff can only Void their own entries'
    db.run(
        'INSERT INTO voids (id, entry_id, user_id, device_id, reason, occurred_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        v['id'],
        v['entryId'],
        actor['id'],
        actor.get('deviceId'),
        v['reason'].strip(),
        at,
        synced_at,
    )
    return None


def void_and_correct(db: Db, actor: dict, entry_id: str, reason, replacement):
    """Dashboard "Void & correct": Voids the wrong entry and records the right one atomically."""
    original = get_entry(db, entry_id)
    if not original:
        raise DomainError('Entry not found', 404)
    now = now_iso()
    push = {
        'voids': [{'id': new_id(), 'entryId': entry_id, 'userId': actor['id'], 'reason': text(reason), 'occurredAt': now}],
        'entries': (
            [{**replacement, 'id': new_id(), 'userId': actor['id'], 'occurredAt': original['occurredAt']}]
            if isinstance(replacement, dict)
            else []
        ),
    }
    # Validate the replacement before voiding anything.
    if push['entries']:
        problem = validate_entry(push['entries'][0], *_lookups(db))
        if problem:
            raise DomainError(problem)
    res = apply_sync(db, actor, push)
    if res['rejected']:
        raise DomainError(res['rejected'][0]['reason'])


def list_activity(db: Db, f: dict) -> dict:
    where: list[str] = []
    params: list = []
    if f.get('giftId'):
        where.append('e.gift_id = ?')
        params.append(f['giftId'])
    if f.get('locationId'):
        where.append('(e.location_id = ? OR e.to_location_id = ?)')
        params += [f['locationId'], f['locationId']]
    if f.get('eventId'):
        events = {e['id']: e for e in list_events(db)}
        ids = [i for i in events if resolve_event_id(i, events) == f['eventId']]
        where.append(f"e.event_id IN ({','.join('?' for _ in ids) or chr(39) * 2})")
        params += ids
    if f.get('kind'):
        where.append('e.kind = ?')
        params.append(f['kind'])
    if f.get('from'):
        where.append('e.occurred_ms >= ?')
        params.append(parse_time_ms(f['from']))
    if f.get('to'):
        where.append('e.occurred_ms < ?')
        params.append(parse_time_ms(f['to']))
    clause = f"WHERE {' AND '.join(where)}" if where else ''
    total = db.one(f'SELECT COUNT(*) AS n FROM entries e {clause}', *params)['n']
    rows = db.all(
        f"""SELECT e.*, u.display_name AS user_name, d.name AS device_name,
                   v.reason AS void_reason, v.occurred_at AS void_at, vu.display_name AS void_by
            FROM entries e
            JOIN users u ON u.id = e.user_id
            LEFT JOIN devices d ON d.id = e.device_id
            LEFT JOIN voids v ON v.entry_id = e.id
            LEFT JOIN users vu ON vu.id = v.user_id
            {clause}
            ORDER BY e.occurred_ms DESC, e.id DESC
            LIMIT ? OFFSET ?""",
        *params,
        f.get('limit', 100),
        f.get('offset', 0),
    )
    out = []
    for r in rows:
        out.append(
            {
                **_to_entry(r),
                'syncedAt': r['synced_at'],
                'userName': r['user_name'],
                'deviceName': r['device_name'],
                'voided': {'reason': r['void_reason'], 'at': r['void_at'], 'byName': r['void_by'] or ''} if r['void_reason'] else None,
            }
        )
    return {'rows': out, 'total': total}
