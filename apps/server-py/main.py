"""Gift Inventory server: API + dashboard on the local network.

Start it with start-server.bat in the project folder (or: python apps/server-py/main.py).
Settings come from environment variables:
  GIFTS_PORT            port to listen on (default 8080)
  GIFTS_DATA_DIR        where gifts.db, photos and logs live (default: <project>/data)
  GIFTS_DASHBOARD_DIR   the built dashboard (default: <project>/apps/dashboard/dist)
  GIFTS_LOG_REQUESTS=1  log every request (off by default: phones sync every 30 s)
"""
from __future__ import annotations

import logging
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from gifts_server.app import App, lan_addresses  # noqa: E402
from gifts_server.backup import schedule_backups  # noqa: E402
from gifts_server.db import Db  # noqa: E402
from gifts_server.store import ensure_default_location  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
log = logging.getLogger('gifts')


def make_handler(app: App, log_requests: bool):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'GiftInventory'
        sys_version = ''

        def _serve(self):
            length = int(self.headers.get('Content-Length') or 0)
            if length > 25 * 1024 * 1024:
                self.send_error(413)
                return
            body = self.rfile.read(length) if length else b''
            resp = app.handle(self.command, self.path, dict(self.headers.items()), body)
            self.send_response(resp.status)
            for k, v in resp.headers:
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(resp.body)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(resp.body)

        do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = do_PATCH = _serve

        def log_message(self, fmt, *args):
            if log_requests:
                log.info('%s %s', self.address_string(), fmt % args)

    return Handler


def setup_logging(data_dir: str):
    logs = os.path.join(data_dir, 'logs')
    os.makedirs(logs, exist_ok=True)
    fmt = logging.Formatter('%(asctime)s %(levelname)s %(message)s', '%Y-%m-%d %H:%M:%S')
    file = RotatingFileHandler(os.path.join(logs, 'server.log'), maxBytes=5_000_000, backupCount=3, encoding='utf-8')
    file.setFormatter(fmt)
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    log.setLevel(os.environ.get('GIFTS_LOG_LEVEL', 'INFO').upper())
    log.addHandler(file)
    log.addHandler(console)


def main():
    port = int(os.environ.get('GIFTS_PORT') or 8080)
    data_dir = os.path.abspath(os.environ.get('GIFTS_DATA_DIR') or os.path.join(REPO, 'data'))
    dashboard_dir = os.path.abspath(os.environ.get('GIFTS_DASHBOARD_DIR') or os.path.join(REPO, 'apps', 'dashboard', 'dist'))

    os.makedirs(data_dir, exist_ok=True)
    setup_logging(data_dir)
    db = Db(os.path.join(data_dir, 'gifts.db'))
    ensure_default_location(db)
    app = App(db, data_dir, port, dashboard_dir)

    try:
        server = ThreadingHTTPServer(('0.0.0.0', port), make_handler(app, os.environ.get('GIFTS_LOG_REQUESTS') == '1'))
    except OSError as err:
        log.error('Cannot listen on port %s (%s). Is the server already running, in another window or as the old startup task?', port, err)
        sys.exit(1)
    server.daemon_threads = True

    schedule_backups(db, app.photos_dir, app.lock, log.info)
    log.info('Gift Inventory server started on port %s', port)
    log.info('Data folder: %s', data_dir)
    if not app.dashboard_dir:
        log.warning('Dashboard files not found in %s, so only the API is served. Build them with: npm run build -w @gifts/dashboard', dashboard_dir)
    for ip in lan_addresses():
        log.info('Dashboard: http://%s:%s', ip, port)
    log.info('Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        log.info('Stopping...')
        server.server_close()
        with app.lock:
            db.close()


if __name__ == '__main__':
    main()
