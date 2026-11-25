"""The HTTP API (same URLs and JSON as the original Node server) and the dashboard's static files."""
from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import socket
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import parse_qs, unquote, urlsplit

from . import auth, reports, sheets, store
from .backup import run_backup
from .db import Db, get_setting, set_setting
from .labels import SHEETS, render_labels_pdf
from .util import DomainError, js_number, now_iso, now_ms, text

COOKIE = 'gifts_sid'
BODY_LIMIT = 20 * 1024 * 1024
FILE_LIMIT = 15 * 1024 * 1024
XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

log = logging.getLogger('gifts')

# Windows' registry sometimes maps .js to text/plain, which browsers refuse for scripts.
_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.map': 'application/json; charset=utf-8',
}


@dataclass
class Request:
    method: str
    path: str
    query: dict
    headers: dict  # lower-case names
    body: bytes = b''
    params: dict = field(default_factory=dict)
    session: dict | None = None
    _json: object = None
    _parsed: bool = False

    def json(self) -> dict:
        """The JSON body, or {} when there is none."""
        if not self._parsed:
            self._parsed = True
            if self.body.strip():
                try:
                    self._json = json.loads(self.body.decode('utf-8'))
                except (ValueError, UnicodeDecodeError) as err:
                    raise DomainError('Body is not valid JSON') from err
        return self._json if isinstance(self._json, dict) else {}

    def cookie(self, name: str) -> str | None:
        for part in self.headers.get('cookie', '').split(';'):
            k, _, v = part.strip().partition('=')
            if k == name:
                return unquote(v)
        return None

    def token(self) -> str | None:
        h = self.headers.get('authorization', '')
        return h[7:] if h.startswith('Bearer ') else self.cookie(COOKIE)

    def file(self) -> dict | None:
        """The first uploaded file of a multipart/form-data body: {'filename', 'mimetype', 'data'}."""
        ctype = self.headers.get('content-type', '')
        m = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', ctype)
        if not ctype.startswith('multipart/form-data') or not m:
            raise DomainError('Expected a file upload (multipart/form-data)', 406)
        boundary = (m.group(1) or m.group(2)).strip().encode()
        for part in self.body.split(b'--' + boundary)[1:]:
            if part.startswith(b'--'):
                break
            head, sep, data = part.partition(b'\r\n\r\n')
            if not sep:
                continue
            if data.endswith(b'\r\n'):
                data = data[:-2]
            head_text = head.decode('utf-8', errors='replace')
            disp = re.search(r'content-disposition:[^\r\n]*', head_text, re.I)
            fname = re.search(r'filename="([^"]*)"', disp.group(0)) if disp else None
            if not fname:
                continue
            mt = re.search(r'content-type:\s*([^\r\n;]+)', head_text, re.I)
            if len(data) > FILE_LIMIT:
                raise DomainError('File is too large (15 MB at most)', 413)
            return {'filename': fname.group(1), 'mimetype': mt.group(1).strip().lower() if mt else '', 'data': data}
        return None


@dataclass
class Response:
    status: int = 200
    body: bytes = b''
    headers: list = field(default_factory=list)


def json_response(obj, status: int = 200) -> Response:
    body = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return Response(status, body, [('Content-Type', 'application/json; charset=utf-8')])


def lan_addresses() -> list[str]:
    """IPv4 addresses phones could use to reach this PC, typical home/office ranges first."""
    found: list[str] = []
    try:
        # The address of the interface that would carry traffic to the internet (no packet is sent).
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('10.255.255.255', 1))
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except OSError:
        pass
    out = []
    for ip in found:
        # Skip 169.254.x.x: Windows' self-assigned "no network" address, unreachable from phones.
        if ip.startswith('127.') or ip.startswith('169.254.') or ip == '0.0.0.0' or ip in out:
            continue
        out.append(ip)

    def rank(ip):
        return 0 if ip.startswith('192.168.') else 1 if ip.startswith('10.') else 2 if ip.startswith('172.') else 3

    return sorted(out, key=rank)


def clamp_int(v, default: int, lo: int, hi: int) -> int:
    n = js_number(v) if v is not None else float('nan')
    if n != n or n in (float('inf'), float('-inf')):
        return default
    return int(min(hi, max(lo, int(n))))


KIND_LABEL = {'count': 'Count', 'receive': 'Receive', 'issue': 'Issue', 'transfer': 'Transfer', 'writeoff': 'Write-off'}


class App:
    def __init__(self, db: Db, data_dir: str, port: int, dashboard_dir: str | None = None):
        self.db = db
        self.data_dir = data_dir
        self.port = port
        self.dashboard_dir = dashboard_dir if dashboard_dir and os.path.isdir(dashboard_dir) else None
        self.photos_dir = os.path.join(data_dir, 'photos')
        # One request at a time touches the database, as in the single-threaded Node server.
        self.lock = threading.RLock()
        self.routes: list[tuple[str, re.Pattern, object]] = []
        self._register()

    # ---------- plumbing ----------

    def route(self, method: str, pattern: str):
        regex = re.compile('^' + re.sub(r':(\w+)', r'(?P<\1>[^/]+?)', pattern.replace('.', r'\.')) + '$')

        def deco(fn):
            self.routes.append((method, regex, fn))
            return fn

        return deco

    def handle(self, method: str, url: str, headers: dict, body: bytes = b'') -> Response:
        parts = urlsplit(url)
        path = unquote(parts.path)
        query = {k: v[0] for k, v in parse_qs(parts.query, keep_blank_values=True).items()}
        req = Request(method.upper(), path, query, {k.lower(): v for k, v in headers.items()}, body)
        try:
            if len(body) > BODY_LIMIT:
                raise DomainError('Request body is too large', 413)
            for m, regex, fn in self.routes:
                match = regex.match(path)
                if match and m == req.method:
                    req.params = {k: unquote(v) for k, v in match.groupdict().items()}
                    with self.lock:
                        req.session = auth.session_for(self.db, req.token())
                        result = fn(req)
                    return result if isinstance(result, Response) else json_response(result)
            if path.startswith('/api/'):
                return json_response({'error': 'Not found'}, 404)
            return self._static(req)
        except DomainError as err:
            return json_response({'error': err.message}, err.status)
        except Exception:  # noqa: BLE001
            log.exception('Error handling %s %s', method, path)
            return json_response({'error': 'Something went wrong on the server'}, 500)

    def _static(self, req: Request) -> Response:
        if not self.dashboard_dir or req.method not in ('GET', 'HEAD'):
            return json_response({'error': 'Not found'}, 404)
        root = os.path.realpath(self.dashboard_dir)
        target = os.path.realpath(os.path.join(root, req.path.lstrip('/')))
        if not (target.startswith(root + os.sep) and os.path.isfile(target)):
            target = os.path.join(root, 'index.html')  # single-page app: let the dashboard route it
        ext = os.path.splitext(target)[1].lower()
        ctype = _TYPES.get(ext) or mimetypes.guess_type(target)[0] or 'application/octet-stream'
        with open(target, 'rb') as f:
            data = f.read()
        cache = 'no-cache' if ext == '.html' else 'public, max-age=31536000, immutable' if '/assets/' in req.path else 'public, max-age=0'
        return Response(200, data, [('Content-Type', ctype), ('Cache-Control', cache)])

    def require_user(self, req: Request) -> dict:
        if not req.session:
            raise DomainError('Please sign in', 401)
        return req.session

    def require_admin(self, req: Request) -> dict:
        s = self.require_user(req)
        if s['user']['role'] != 'admin':
            raise DomainError('Only an Admin can do that', 403)
        return s

    @staticmethod
    def actor_of(s: dict) -> dict:
        return {'id': s['user']['id'], 'role': s['user']['role'], 'deviceId': s['deviceId']}

    def servers(self) -> list[str]:
        return [f'http://{ip}:{self.port}' for ip in lan_addresses()]

    @staticmethod
    def with_cookie(resp: Response, token: str) -> Response:
        # Private LAN over plain HTTP, so no Secure flag. 180 days; the dashboard stays signed in.
        resp.headers.append(('Set-Cookie', f'{COOKIE}={token}; Max-Age={180 * 86400}; Path=/; HttpOnly; SameSite=Lax'))
        return resp

    @staticmethod
    def download(data: bytes, ctype: str, filename: str, inline: bool = False) -> Response:
        disp = 'inline' if inline else 'attachment'
        return Response(200, data, [('Content-Type', ctype), ('Content-Disposition', f'{disp}; filename="{filename}"')])

    # ---------- routes ----------

    def _register(self):
        db = self.db
        r = self.route

        # ----- Public -----

        @r('GET', '/api/health')
        def health(req):
            return {'ok': True, 'app': 'gift-inventory', 'serverTime': now_iso()}

        @r('GET', '/api/setup/status')
        def setup_status(req):
            return {'needsSetup': auth.count_users(db) == 0}

        @r('POST', '/api/setup')
        def setup(req):
            if auth.count_users(db) > 0:
                raise DomainError('Setup is already done', 409)
            body = req.json()
            auth.create_user(db, {**body, 'role': 'admin'})
            token, user = auth.login_web(db, body.get('username'), body.get('password'))
            return self.with_cookie(json_response({'user': user}), token)

        @r('POST', '/api/auth/login')
        def login(req):
            body = req.json()
            token, user = auth.login_web(db, body.get('username'), body.get('password'))
            return self.with_cookie(json_response({'user': user}), token)

        @r('POST', '/api/auth/logout')
        def logout(req):
            token = req.token()
            if token:
                auth.logout(db, token)
            resp = json_response({'ok': True})
            resp.headers.append(('Set-Cookie', f'{COOKIE}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'))
            return resp

        @r('GET', '/api/auth/me')
        def me(req):
            s = self.require_user(req)
            return {'user': s['user'], 'deviceId': s['deviceId']}

        @r('POST', '/api/devices/pair')
        def pair(req):
            body = req.json()
            return auth.pair_device(db, body.get('code'), body.get('name'))

        @r('POST', '/api/auth/device-login')
        def device_login(req):
            body = req.json()
            return auth.login_device(db, body.get('deviceToken'), body.get('username'), body.get('password'))

        # ----- Phone sync (any signed-in User) -----

        @r('GET', '/api/sync/catalog')
        def catalog(req):
            s = self.require_user(req)
            if s['deviceId']:
                auth.mark_device_synced(db, s['deviceId'])
            return {
                'serverTime': now_iso(),
                'me': s['user'],
                'gifts': store.list_gifts(db),
                'categories': store.list_categories(db),
                'locations': store.list_locations(db),
                'events': store.list_events(db),
                'stock': store.stock_levels(db),
            }

        @r('POST', '/api/sync/push')
        def push(req):
            s = self.require_user(req)
            result = store.apply_sync(db, self.actor_of(s), req.json())
            if s['deviceId']:
                auth.mark_device_synced(db, s['deviceId'])
            return result

        @r('GET', '/api/gifts/:id/photo')
        def photo(req):
            self.require_user(req)
            f = store.get_gift_photo_file(db, req.params['id'])
            path = os.path.join(self.photos_dir, f) if f else None
            if not path or not os.path.isfile(path):
                raise DomainError('No photo', 404)
            ctype = 'image/png' if f.endswith('.png') else 'image/webp' if f.endswith('.webp') else 'image/jpeg'
            with open(path, 'rb') as fh:
                return Response(200, fh.read(), [('Content-Type', ctype), ('Cache-Control', 'private, max-age=86400')])

        # Recent activity is useful to Staff on the phone too (e.g. to Void their own typo).
        @r('GET', '/api/entries')
        def entries(req):
            self.require_user(req)
            q = req.query
            return store.list_activity(
                db,
                {
                    'giftId': q.get('giftId'),
                    'locationId': q.get('locationId'),
                    'eventId': q.get('eventId'),
                    'kind': q.get('kind'),
                    'from': q.get('from'),
                    'to': q.get('to'),
                    'limit': clamp_int(q.get('limit'), 100, 1, 1000),
                    'offset': clamp_int(q.get('offset'), 0, 0, 10**9),
                },
            )

        # ----- Admin: Gifts, Categories, Locations -----

        @r('GET', '/api/gifts')
        def gifts(req):
            self.require_admin(req)
            return store.list_gifts(db)

        @r('POST', '/api/gifts')
        def gift_create(req):
            self.require_admin(req)
            return store.create_gift(db, req.json())

        @r('PUT', '/api/gifts/:id')
        def gift_update(req):
            self.require_admin(req)
            return store.update_gift(db, req.params['id'], req.json())

        @r('POST', '/api/gifts/:id/photo')
        def photo_upload(req):
            self.require_admin(req)
            gid = req.params['id']
            store.get_gift(db, gid)
            f = req.file()
            if not f:
                raise DomainError('No file uploaded')
            ext = {'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg'}.get(f['mimetype'])
            if not ext:
                raise DomainError('Photo must be a JPEG, PNG or WebP image')
            os.makedirs(self.photos_dir, exist_ok=True)
            old = store.get_gift_photo_file(db, gid)
            name = f'{gid}-{now_ms()}.{ext}'
            with open(os.path.join(self.photos_dir, name), 'wb') as fh:
                fh.write(f['data'])
            store.set_gift_photo(db, gid, name)
            if old:
                _remove(os.path.join(self.photos_dir, old))
            return store.get_gift(db, gid)

        @r('DELETE', '/api/gifts/:id/photo')
        def photo_delete(req):
            self.require_admin(req)
            gid = req.params['id']
            old = store.get_gift_photo_file(db, gid)
            store.set_gift_photo(db, gid, None)
            if old:
                _remove(os.path.join(self.photos_dir, old))
            return store.get_gift(db, gid)

        @r('GET', '/api/categories')
        def categories(req):
            self.require_user(req)
            return store.list_categories(db)

        @r('POST', '/api/categories')
        def category_create(req):
            self.require_admin(req)
            cid = store.upsert_category_by_name(db, req.json().get('name'))
            return next((c for c in store.list_categories(db) if c['id'] == cid), None)

        @r('PUT', '/api/categories/:id')
        def category_rename(req):
            self.require_admin(req)
            store.rename_category(db, req.params['id'], req.json().get('name'))
            return {'ok': True}

        @r('GET', '/api/locations')
        def locations(req):
            self.require_user(req)
            return store.list_locations(db)

        @r('POST', '/api/locations')
        def location_create(req):
            self.require_admin(req)
            return store.create_location(db, req.json().get('name'))

        @r('PUT', '/api/locations/:id')
        def location_update(req):
            self.require_admin(req)
            store.update_location(db, req.params['id'], req.json())
            return {'ok': True}

        # ----- Events -----

        @r('GET', '/api/events')
        def events(req):
            self.require_user(req)
            return reports.event_summaries(db)

        @r('POST', '/api/events')
        def event_create(req):
            s = self.require_user(req)
            return store.create_event(db, req.json(), self.actor_of(s))

        @r('PUT', '/api/events/:id')
        def event_update(req):
            self.require_admin(req)
            return store.update_event(db, req.params['id'], req.json())

        @r('POST', '/api/events/:id/close')
        def event_close(req):
            self.require_admin(req)
            store.close_event(db, req.params['id'])
            return store.get_event(db, req.params['id'])

        @r('POST', '/api/events/:id/reopen')
        def event_reopen(req):
            self.require_admin(req)
            store.reopen_event(db, req.params['id'])
            return store.get_event(db, req.params['id'])

        @r('POST', '/api/events/:id/merge')
        def event_merge(req):
            self.require_admin(req)
            store.merge_event(db, req.params['id'], req.json().get('intoId'))
            return {'ok': True}

        @r('GET', '/api/events/:id/report')
        def event_report(req):
            self.require_admin(req)
            rep = reports.event_report(db, req.params['id'])
            if not rep:
                raise DomainError('Event not found', 404)
            return rep

        # ----- Admin: entries -----

        @r('POST', '/api/entries')
        def entry_create(req):
            s = self.require_admin(req)
            res = store.apply_sync(db, self.actor_of(s), {'entries': [{**req.json(), 'userId': s['user']['id']}]})
            if res['rejected']:
                raise DomainError(res['rejected'][0]['reason'])
            return {'ok': True}

        @r('POST', '/api/entries/:id/void')
        def entry_void(req):
            s = self.require_user(req)
            body = req.json()
            store.void_and_correct(db, self.actor_of(s), req.params['id'], body.get('reason') or '', body.get('replacement'))
            return {'ok': True}

        # ----- Admin: Users & Devices -----

        @r('GET', '/api/users')
        def users(req):
            self.require_admin(req)
            return auth.list_users(db)

        @r('POST', '/api/users')
        def user_create(req):
            self.require_admin(req)
            return auth.create_user(db, req.json())

        @r('PUT', '/api/users/:id')
        def user_update(req):
            self.require_admin(req)
            auth.update_user(db, req.params['id'], req.json())
            return {'ok': True}

        @r('GET', '/api/devices')
        def devices(req):
            self.require_admin(req)
            return auth.list_devices(db)

        @r('POST', '/api/devices/:id/revoke')
        def device_revoke(req):
            self.require_admin(req)
            auth.revoke_device(db, req.params['id'])
            return {'ok': True}

        @r('PUT', '/api/devices/:id')
        def device_rename(req):
            self.require_admin(req)
            auth.rename_device(db, req.params['id'], req.json().get('name'))
            return {'ok': True}

        @r('POST', '/api/pairing')
        def pairing(req):
            """A one-time pairing code plus every address phones could use to reach this PC."""
            s = self.require_admin(req)
            p = auth.create_pairing_code(db, s['user']['id'])
            servers = self.servers()
            qr = json.dumps({'app': 'gift-inventory', 'v': 1, 'servers': servers, 'code': p['code']}, separators=(',', ':'))
            return {'code': p['code'], 'expiresAt': p['expiresAt'], 'servers': servers, 'qr': qr}

        # ----- Reports & exports -----

        @r('GET', '/api/reports/alerts')
        def alerts(req):
            self.require_admin(req)
            return reports.alerts(db)

        @r('GET', '/api/reports/stock')
        def stock(req):
            self.require_admin(req)
            return reports.stock_overview(db, include_archived=req.query.get('archived') == '1')

        @r('GET', '/api/export/:report.:format')
        def export(req):
            self.require_admin(req)
            fmt = req.params['format']
            if fmt not in ('xlsx', 'csv'):
                raise DomainError('Format must be xlsx or csv', 404)
            table = export_table(db, req.params['report'], req.query)
            day = datetime.now(timezone.utc).strftime('%Y-%m-%d')
            filename = re.sub(r'[^\w.-]+', '_', f"{table['name']}-{day}.{fmt}", flags=re.ASCII)
            if fmt == 'csv':
                return self.download(sheets.to_csv(table['columns'], table['rows']).encode('utf-8'), 'text/csv; charset=utf-8', filename)
            return self.download(sheets.to_xlsx(table['name'], table['columns'], table['rows']), XLSX, filename)

        # ----- Import & labels -----

        @r('GET', '/api/import/template.xlsx')
        def template_xlsx(req):
            self.require_admin(req)
            return self.download(sheets.import_template(db), XLSX, 'gift-import-template.xlsx')

        @r('GET', '/api/import/template.csv')
        def template_csv(req):
            self.require_admin(req)
            t = sheets.import_template_rows(db)
            return self.download(sheets.to_csv(t['columns'], t['rows']).encode('utf-8'), 'text/csv; charset=utf-8', 'gift-import-template.csv')

        @r('POST', '/api/import/gifts')
        def import_gifts(req):
            s = self.require_admin(req)
            f = req.file()
            if not f:
                raise DomainError('No file uploaded')
            if not re.search(r'\.(xlsx|csv)$', f['filename'], re.I):
                raise DomainError('Upload an .xlsx or .csv file')
            rows = sheets.read_spreadsheet(f['data'], f['filename'])
            return sheets.import_gifts(db, self.actor_of(s), rows)

        @r('POST', '/api/labels.pdf')
        def labels(req):
            self.require_admin(req)
            body = req.json()
            items = body.get('items') or []
            sheet = body.get('sheet') or 'letter-30'
            if sheet not in SHEETS:
                raise DomainError('Unknown sticker sheet')
            gifts = {g['id']: g for g in store.list_gifts(db)}
            cats = {c['id']: c['name'] for c in store.list_categories(db)}
            requests = []
            for it in items if isinstance(items, list) else []:
                gift = gifts.get(it.get('giftId')) if isinstance(it, dict) else None
                if gift:
                    copies = clamp_int(str(it.get('copies')), 1, 1, 500)
                    requests.append({'gift': gift, 'category': cats.get(gift['categoryId']) if gift['categoryId'] else None, 'copies': copies})
            if not requests:
                raise DomainError('Choose at least one Gift')
            pdf = render_labels_pdf(requests, sheet, body.get('skip') or 0)
            return self.download(pdf, 'application/pdf', 'gift-labels.pdf', inline=True)

        # ----- Settings & backup -----

        @r('GET', '/api/settings')
        def settings(req):
            self.require_admin(req)
            return {
                'backupPath': get_setting(db, 'backup.path') or '',
                'lastBackupAt': get_setting(db, 'backup.lastSuccessAt'),
                'lastBackupFolder': get_setting(db, 'backup.lastFolder'),
                'lastBackupError': get_setting(db, 'backup.lastError') or None,
                'dataDir': self.data_dir,
                'addresses': self.servers(),
            }

        @r('PUT', '/api/settings')
        def settings_save(req):
            self.require_admin(req)
            set_setting(db, 'backup.path', text(req.json().get('backupPath')).strip())
            return {'ok': True}

        @r('POST', '/api/backup/run')
        def backup_now(req):
            self.require_admin(req)
            try:
                return run_backup(db, self.photos_dir)
            except Exception as err:  # noqa: BLE001
                raise DomainError(str(err)) from err


def _remove(path: str):
    try:
        os.remove(path)
    except OSError:
        pass


def export_table(db: Db, report: str, q: dict) -> dict:
    if report == 'gifts':
        return sheets.gifts_table(db)  # same format the Gift import reads
    if report == 'stock':
        s = reports.stock_overview(db)
        columns = [
            {'header': 'Gift', 'key': 'name', 'width': 30},
            {'header': 'Category', 'key': 'category'},
            *({'header': l['name'], 'key': f"loc:{l['id']}"} for l in s['locations']),
            {'header': 'Total', 'key': 'total'},
            {'header': 'Unit cost', 'key': 'unitCost'},
            {'header': 'Value', 'key': 'value'},
            {'header': 'Low-Stock Threshold', 'key': 'lowStockThreshold'},
            {'header': 'Status', 'key': 'status'},
        ]
        rows = [
            {
                **row,
                **{f'loc:{k}': v for k, v in row['byLocation'].items()},
                'status': 'Negative' if row['negative'] else 'Low' if row['low'] else '',
            }
            for row in s['rows']
        ]
        return {'name': 'stock', 'columns': columns, 'rows': rows}
    if report == 'events':
        return {
            'name': 'events',
            'columns': [
                {'header': 'Event', 'key': 'name', 'width': 30},
                {'header': 'Start', 'key': 'startDate'},
                {'header': 'End', 'key': 'endDate'},
                {'header': 'Status', 'key': 'status'},
                {'header': 'Pieces issued', 'key': 'piecesIssued'},
                {'header': 'Cost', 'key': 'cost'},
            ],
            'rows': [{**e, 'status': 'Open' if e['open'] else 'Closed'} for e in reports.event_summaries(db)],
        }
    if report == 'event':
        rep = reports.event_report(db, q.get('id') or '')
        if not rep:
            raise DomainError('Event not found', 404)
        return {
            'name': f"event-{rep['event']['name']}",
            'columns': [
                {'header': 'Gift', 'key': 'name', 'width': 30},
                {'header': 'Pieces issued', 'key': 'pieces'},
                {'header': 'Unit cost', 'key': 'unitCost'},
                {'header': 'Cost', 'key': 'cost'},
            ],
            'rows': rep['lines'],
        }
    if report == 'activity':
        gifts = {g['id']: g['name'] for g in store.list_gifts(db)}
        locs = {l['id']: l['name'] for l in store.list_locations(db)}
        events = {e['id']: e['name'] for e in store.list_events(db)}
        rows = store.list_activity(db, {**q, 'limit': 100_000, 'offset': clamp_int(q.get('offset'), 0, 0, 10**9)})['rows']
        return {
            'name': 'activity',
            'columns': [
                {'header': 'When', 'key': 'occurredAt', 'width': 22},
                {'header': 'Type', 'key': 'kindLabel'},
                {'header': 'Gift', 'key': 'gift', 'width': 30},
                {'header': 'Location', 'key': 'location'},
                {'header': 'To Location', 'key': 'toLocation'},
                {'header': 'Pieces', 'key': 'quantity'},
                {'header': 'Event', 'key': 'event'},
                {'header': 'Note', 'key': 'note'},
                {'header': 'User', 'key': 'userName'},
                {'header': 'Device', 'key': 'deviceName'},
                {'header': 'Synced', 'key': 'syncedAt', 'width': 22},
                {'header': 'Voided', 'key': 'voidedText', 'width': 30},
            ],
            'rows': [
                {
                    **row,
                    'kindLabel': KIND_LABEL.get(row['kind'], row['kind']),
                    'gift': gifts.get(row['giftId']),
                    'location': locs.get(row['locationId']),
                    'toLocation': locs.get(row['toLocationId']) if row['toLocationId'] else '',
                    'event': events.get(row['eventId']) if row['eventId'] else '',
                    'voidedText': f"{row['voided']['byName']}: {row['voided']['reason']}" if row['voided'] else '',
                }
                for row in rows
            ],
        }
    raise DomainError('Unknown report', 404)
