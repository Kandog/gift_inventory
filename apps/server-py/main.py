"""Gift Inventory server: API + dashboard on the local network.

Start it with start-server.bat in the project folder (or: python apps/server-py/main.py).
Settings come from environment variables:
  GIFTS_PORT            HTTP port: dashboard, API, Android app (default 8080)
  GIFTS_HTTPS_PORT      HTTPS port for the phone web app at /app (default 8443; 0 turns HTTPS off)
  GIFTS_PHONE_DIR       the built phone web app (default: <project>/apps/mobile/dist)
  GIFTS_DATA_DIR        where gifts.db, photos and logs live (default: <project>/data)
  GIFTS_DASHBOARD_DIR   the built dashboard (default: <project>/apps/dashboard/dist)
  GIFTS_LOG_REQUESTS=1  log every request (off by default: phones sync every 30 s)
"""
from __future__ import annotations

import logging
import os
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from logging.handlers import RotatingFileHandler

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from gifts_server.app import App, lan_addresses  # noqa: E402
from gifts_server.backup import schedule_backups  # noqa: E402
from gifts_server.certs import ensure_certs  # noqa: E402
from gifts_server.db import Db  # noqa: E402
from gifts_server.store import ensure_default_location  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
log = logging.getLogger('gifts')


def make_handler(app: App, log_requests: bool, secure: bool = False):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'
        server_version = 'GiftInventory'
        sys_version = ''
        timeout = 60  # drop connections that stay silent, so they don't tie up a thread

        def setup(self):
            super().setup()
            if secure:
                self.connection.do_handshake()  # in this connection's own thread

        def _serve(self):
            length = int(self.headers.get('Content-Length') or 0)
            if length > 25 * 1024 * 1024:
                self.send_error(413)
                return
            body = self.rfile.read(length) if length else b''
            resp = app.handle(self.command, self.path, dict(self.headers.items()), body, secure=secure)
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


class HttpsServer(ThreadingHTTPServer):
    """Encrypts each connection in its own thread, so one slow phone can't hold up the others."""

    def __init__(self, addr, handler, context: ssl.SSLContext):
        self.context = context
        super().__init__(addr, handler)

    def get_request(self):
        sock, addr = self.socket.accept()
        return self.context.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), addr

    def handle_error(self, request, client_address):
        # A phone that doesn't trust the certificate yet just disconnects; that isn't a server problem.
        err = sys.exc_info()[1]
        if isinstance(err, (ssl.SSLError, ConnectionError, TimeoutError, OSError)):
            log.debug('HTTPS connection from %s closed: %s', client_address[0], err)
            return
        super().handle_error(request, client_address)


def start_https(app: App, data_dir: str, port: int, log_requests: bool):
    """Starts the HTTPS listener for the phone web app, and renews its certificate when needed."""
    certs = ensure_certs(data_dir, lan_addresses())
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certs.server_crt, certs.server_key)
    server = HttpsServer(('0.0.0.0', port), make_handler(app, log_requests, secure=True), context)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name='https', daemon=True).start()

    def renew():
        # Daily: renew before expiry, or when this PC got a new IP address. New connections use it.
        while True:
            time.sleep(24 * 3600)
            try:
                before = os.path.getmtime(certs.server_crt)
                ensure_certs(data_dir, lan_addresses())
                if os.path.getmtime(certs.server_crt) != before:
                    context.load_cert_chain(certs.server_crt, certs.server_key)
            except Exception as err:  # noqa: BLE001
                log.warning('Could not renew the HTTPS certificate: %s', err)

    threading.Thread(target=renew, name='cert-renewal', daemon=True).start()
    return server, certs


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
    phone_dir = os.path.abspath(os.environ.get('GIFTS_PHONE_DIR') or os.path.join(REPO, 'apps', 'mobile', 'dist'))
    https_env = os.environ.get('GIFTS_HTTPS_PORT')
    https_port = int(https_env) if https_env not in (None, '') else 8443
    log_requests = os.environ.get('GIFTS_LOG_REQUESTS') == '1'

    os.makedirs(data_dir, exist_ok=True)
    setup_logging(data_dir)
    db = Db(os.path.join(data_dir, 'gifts.db'))
    ensure_default_location(db)
    app = App(db, data_dir, port, dashboard_dir, phone_dir, https_port or None)

    try:
        server = ThreadingHTTPServer(('0.0.0.0', port), make_handler(app, log_requests))
    except OSError as err:
        log.error('Cannot listen on port %s (%s). Is the server already running, in another window or as the old startup task?', port, err)
        sys.exit(1)
    server.daemon_threads = True
    https_server = None
    if https_port:
        try:
            https_server, app.phone.certs = start_https(app, data_dir, https_port, log_requests)
        except OSError as err:
            log.error('Cannot listen on HTTPS port %s (%s). The phone web app is off; the dashboard still works.', https_port, err)
            app.phone.https_port = None

    schedule_backups(db, app.photos_dir, app.lock, log.info)
    log.info('Gift Inventory server started on port %s', port)
    log.info('Data folder: %s', data_dir)
    if not app.dashboard_dir:
        log.warning('Dashboard files not found in %s, so only the API is served. Build them with: npm run build -w @gifts/dashboard', dashboard_dir)
    for ip in lan_addresses():
        log.info('Dashboard: http://%s:%s', ip, port)
    if https_server:
        if not app.phone.dir:
            log.warning('Phone web app not found in %s. Build it with: npm run build:phone-web', phone_dir)
        for ip in lan_addresses():
            log.info('Phone setup: http://%s:%s/phone', ip, port)
    log.info('Press Ctrl+C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        log.info('Stopping...')
        server.server_close()
        if https_server:
            https_server.server_close()
        with app.lock:
            db.close()


if __name__ == '__main__':
    main()
