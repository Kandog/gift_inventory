"""CSV / Excel export, and the Gift import (same format as the Gift export, so files round-trip)."""
from __future__ import annotations

import io
import math
import re
from datetime import date, datetime

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

from .db import Db
from .rules import stock_key
from .store import (
    apply_sync,
    create_gift,
    create_location,
    list_categories,
    list_gifts,
    list_locations,
    stock_map,
    update_gift,
    upsert_category_by_name,
)
from .util import DomainError, is_int, js_number, js_str, new_id, now_iso

# A column is {'header': str, 'key': str, 'width': int | None}.

# ---------- Export ----------

_BAD_SHEET_CHARS = re.compile(r'[\\/?*\[\]:]')


def to_xlsx(sheet_name: str, columns: list[dict], rows: list[dict]) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = _BAD_SHEET_CHARS.sub('_', sheet_name)[:31] or 'Sheet1'
    ws.append([c['header'] for c in columns])
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for i, c in enumerate(columns, start=1):
        ws.column_dimensions[get_column_letter(i)].width = c.get('width') or max(12, len(c['header']) + 2)
    ws.freeze_panes = 'A2'
    for r in rows:
        ws.append([_xlsx_value(r.get(c['key'])) for c in columns])
    out = io.BytesIO()
    wb.save(out)
    return out.getvalue()


def _xlsx_value(v):
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def to_csv(columns: list[dict], rows: list[dict]) -> str:
    def esc(v) -> str:
        s = js_str(v)
        return '"' + s.replace('"', '""') + '"' if re.search(r'[",\r\n]', s) else s

    lines = [','.join(esc(c['header']) for c in columns)]
    lines += [','.join(esc(r.get(c['key'])) for c in columns) for r in rows]
    return '﻿' + '\r\n'.join(lines) + '\r\n'  # BOM so Excel opens UTF-8 correctly


# ---------- Gift CSV format (shared by export, template and import) ----------

GIFT_COLUMNS = ['ID', 'Name', 'Category', 'Unit Cost', 'Low Stock Threshold', 'Packs', 'Barcodes', 'Archived']
STOCK_PREFIX = 'stock:'


def _packs_text(packs) -> str:
    return '; '.join(f"{p['name']}={p['pieces']}" for p in packs)


def _gift_columns(db: Db) -> list[dict]:
    locs = [l for l in list_locations(db) if not l['archived']]
    cols = [{'header': h, 'key': h, 'width': 30 if h == 'Name' else 38 if h == 'ID' else 18} for h in GIFT_COLUMNS]
    cols += [{'header': f"Stock: {l['name']}", 'key': f"Stock: {l['name']}", 'width': 16} for l in locs]
    return cols


def gifts_table(db: Db) -> dict:
    """Every Gift (including archived) in the import format, with current Stock Levels."""
    columns = _gift_columns(db)
    locs = [l for l in list_locations(db) if not l['archived']]
    cats = {c['id']: c['name'] for c in list_categories(db)}
    levels = stock_map(db)
    rows = []
    for g in list_gifts(db):
        row = {
            'ID': g['id'],
            'Name': g['name'],
            'Category': cats.get(g['categoryId'], '') if g['categoryId'] else '',
            'Unit Cost': g['unitCost'],
            'Low Stock Threshold': g['lowStockThreshold'],
            'Packs': _packs_text(g['packs']),
            'Barcodes': '; '.join(g['barcodes']),
            'Archived': 'yes' if g['archived'] else 'no',
        }
        for l in locs:
            row[f"Stock: {l['name']}"] = levels.get(stock_key(g['id'], l['id']), 0)
        rows.append(row)
    return {'name': 'gifts', 'columns': columns, 'rows': rows}


def import_template_rows(db: Db) -> dict:
    """The import format with one example row, for people starting a file from scratch."""
    columns = _gift_columns(db)
    example = {
        'ID': '',
        'Name': 'Blue logo pen',
        'Category': 'Pens',
        'Unit Cost': 0.85,
        'Low Stock Threshold': 100,
        'Packs': 'Carton=50; Box=10',
        'Barcodes': '0123456789012',
        'Archived': 'no',
    }
    first_stock = next((c for c in columns if c['header'].lower().startswith(STOCK_PREFIX)), None)
    if first_stock:
        example[first_stock['key']] = 420
    return {'columns': columns, 'rows': [example]}


def import_template(db: Db) -> bytes:
    t = import_template_rows(db)
    return to_xlsx('Gifts', t['columns'], t['rows'])


# ---------- Import ----------


def read_spreadsheet(data: bytes, filename: str) -> list[dict]:
    if filename.lower().endswith('.csv'):
        return parse_csv(data.decode('utf-8', errors='replace').lstrip('﻿'))
    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as err:  # noqa: BLE001 - any unreadable file
        raise DomainError(f'Cannot read this Excel file ({err})') from err
    if not wb.worksheets:
        return []
    ws = wb.worksheets[0]
    it = ws.iter_rows(values_only=True)
    header_row = next(it, None)
    if header_row is None:
        return []
    headers = [_cell_text(h) for h in header_row]
    rows = []
    for values in it:
        r = {}
        for col, v in enumerate(values):
            h = headers[col] if col < len(headers) else ''
            if h and v is not None and v != '':
                r[h] = _cell_text(v)
        rows.append(r)
    wb.close()
    return rows


def _cell_text(v) -> str:
    if v is None:
        return ''
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    return js_str(v).strip()


def parse_csv(text: str) -> list[dict]:
    records: list[list[str]] = []
    field = ''
    record: list[str] = []
    quoted = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if quoted:
            if ch == '"' and i + 1 < n and text[i + 1] == '"':
                field += '"'
                i += 1
            elif ch == '"':
                quoted = False
            else:
                field += ch
        elif ch == '"':
            quoted = True
        elif ch == ',':
            record.append(field)
            field = ''
        elif ch in '\r\n':
            if ch == '\r' and i + 1 < n and text[i + 1] == '\n':
                i += 1
            record.append(field)
            records.append(record)
            record = []
            field = ''
        else:
            field += ch
        i += 1
    if field or record:
        record.append(field)
        records.append(record)
    records = [r for r in records if any(c.strip() for c in r)]
    if not records:
        return []
    header, body = records[0], records[1:]
    return [{h.strip(): (cells[i] if i < len(cells) else '').strip() for i, h in enumerate(header)} for cells in body]


_PACK_RE = re.compile(r'^(.+?)\s*[=:x×]\s*(\d+)$', re.IGNORECASE)


def _parse_packs(s: str) -> list[dict]:
    if not s:
        return []
    out = []
    for part in re.split(r'[;\n]', s):
        m = _PACK_RE.match(part.strip())
        if not m:
            raise DomainError(f'Cannot read Pack "{part.strip()}" (use e.g. Carton=50)')
        out.append({'name': m.group(1).strip(), 'pieces': int(m.group(2))})
    return out


def _num(s):
    if s is None or s.strip() == '':
        return None
    n = js_number(re.sub(r'[$,]', '', s))
    return int(n) if is_int(n) else n


def _parse_archived(s):
    v = (s or '').strip().lower()
    if v == '':
        return None
    if v in ('yes', 'y', 'true', '1', 'archived'):
        return True
    if v in ('no', 'n', 'false', '0', 'active'):
        return False
    raise DomainError(f'Archived must be yes or no (got "{s}")')


class _RowFailed(Exception):
    pass


def import_gifts(db: Db, actor: dict, raw_rows: list[dict]) -> dict:
    """Creates or updates Gifts from rows in the Gift CSV format. Column names ignore case.

    - A row with an ID updates that Gift (so it can be renamed); without an ID it matches by Name,
      and creates a new Gift when no Gift has that name.
    - Each row describes the Gift completely: an empty Unit Cost, Packs, etc. clears that field.
      An empty Archived keeps the Gift's current state.
    - "Stock: <Location>" values are recorded as Counts by the importing Admin. Empty cells and values
      equal to the current Stock Level are skipped, so re-importing an export changes nothing.
    """
    summary = {'created': 0, 'updated': 0, 'counts': 0, 'errors': []}
    now = now_iso()
    counts: list[dict] = []
    levels = stock_map(db)
    rows = [{k.strip().lower(): (v or '') for k, v in r.items()} for r in raw_rows]
    stock_headers = [[k.strip() for k in r if k.strip().lower().startswith(STOCK_PREFIX)] for r in raw_rows]

    with db.tx():
        for i, r in enumerate(rows):
            row_no = i + 2  # header is row 1
            name = r.get('name', '').strip()
            if not any(v.strip() for v in r.values()):
                continue  # blank line
            try:
                # Each row is its own savepoint: a bad row leaves nothing half-written.
                with db.tx():
                    created, row_counts = _import_row(db, actor, r, name, stock_headers[i], levels, now)
                summary['created' if created else 'updated'] += 1
                counts.extend(row_counts)
            except DomainError as err:
                summary['errors'].append({'row': row_no, 'message': err.message})

    if counts:
        res = apply_sync(db, actor, {'entries': counts})
        summary['counts'] = len(res['accepted'])
        for rej in res['rejected']:
            summary['errors'].append({'row': 0, 'message': f"Count not recorded: {rej['reason']}"})
    return summary


def _import_row(db: Db, actor: dict, r: dict, name: str, headers: list[str], levels: dict, now: str):
    if not name:
        raise DomainError('Name is empty')
    unit_cost = _num(r.get('unit cost'))
    threshold = _num(r.get('low stock threshold'))
    if isinstance(unit_cost, float) and math.isnan(unit_cost):
        raise DomainError('Unit Cost is not a number')
    if isinstance(threshold, float) and math.isnan(threshold):
        raise DomainError('Low Stock Threshold is not a number')
    archived = _parse_archived(r.get('archived'))
    gid = r.get('id', '').strip()
    gifts = list_gifts(db)
    if gid:
        existing = next((g for g in gifts if g['id'] == gid), None)
    else:
        existing = next((g for g in gifts if g['name'].lower() == name.lower()), None)
    if gid and not existing:
        raise DomainError(f'No Gift has ID {gid}. Leave ID empty to create a new Gift.')
    inp = {
        'name': name,
        'categoryId': upsert_category_by_name(db, r['category']) if r.get('category', '').strip() else None,
        'unitCost': unit_cost,
        'lowStockThreshold': threshold,
        'packs': _parse_packs(r.get('packs', '')),
        'barcodes': [b for b in re.split(r'[;,\s]+', r.get('barcodes', '')) if b],
        'archived': archived if archived is not None else (existing['archived'] if existing else False),
    }
    gift = update_gift(db, existing['id'], inp) if existing else create_gift(db, inp)

    row_counts = []
    for header in headers:
        value = r.get(header.lower(), '')
        if value.strip() == '':
            continue
        loc_name = header[len(STOCK_PREFIX):].strip()
        qty = js_number(value.strip())
        loc_id = next((l['id'] for l in list_locations(db) if l['name'].lower() == loc_name.lower()), None)
        if loc_id and levels.get(stock_key(gift['id'], loc_id), 0) == qty:
            continue  # unchanged
        if not is_int(qty) or qty < 0:
            raise DomainError(f'"Stock: {loc_name}" must be a whole number, 0 or more')
        row_counts.append(
            {
                'id': new_id(),
                'kind': 'count',
                'giftId': gift['id'],
                'locationId': loc_id or create_location(db, loc_name)['id'],
                'quantity': int(qty),
                'userId': actor['id'],
                'occurredAt': now,
                'note': 'Imported',
            }
        )
    return existing is None, row_counts
