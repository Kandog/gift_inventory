"""Serves the browser version of the phone app at /app, plus the /phone setup page and the HTTPS certificate.

Browsers only allow the camera (for scanning) and offline caching on HTTPS, so /app over plain HTTP
redirects to the HTTPS port. The /phone page and the certificate download stay on HTTP: a phone must
be able to fetch them before it trusts the certificate.
"""
from __future__ import annotations

import hashlib
import html
import json
import os

CA_PATH = '/gift-inventory-ca.crt'

_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8',
}

# Added to the app's index.html so "Add to Home Screen" gives a full-screen app with its own icon.
_HEAD = """<link rel="manifest" href="/app/manifest.webmanifest">
<link rel="apple-touch-icon" href="/app/icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Gifts">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
"""

_MANIFEST = {
    'name': 'Gift Inventory',
    'short_name': 'Gifts',
    'start_url': '/app/',
    'scope': '/app/',
    'display': 'standalone',
    'orientation': 'portrait',
    'background_color': '#ffffff',
    'theme_color': '#ffffff',
    'icons': [{'src': '/app/icon.png', 'sizes': '1024x1024', 'type': 'image/png', 'purpose': 'any'}],
}

# Keeps the app's files on the phone. Pages come from the network when the PC answers (so updates
# arrive), and from the phone's copy when it doesn't. API calls are never cached: the app keeps its
# own offline data and outbox.
_SW = """const VERSION = %(version)s;
const CACHE = 'gift-inventory-' + VERSION;
const FILES = %(files)s;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gift-inventory-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/app/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      Promise.race([fetch(req), timeout(4000)])
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/app/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/app/index.html')),
    );
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
"""


def _host_name(host_header: str) -> str:
    """The host part of a Host header: '192.168.1.37:8080' -> '192.168.1.37', '[::1]:80' -> '[::1]'."""
    h = host_header.strip()
    if h.startswith('['):
        return h[: h.index(']') + 1] if ']' in h else h
    return h.rsplit(':', 1)[0] if ':' in h else h


class PhoneApp:
    def __init__(self, phone_dir: str | None, http_port: int, https_port: int | None, certs):
        self.dir = os.path.realpath(phone_dir) if phone_dir and os.path.isfile(os.path.join(phone_dir, 'index.html')) else None
        self.http_port = http_port
        self.https_port = https_port
        self.certs = certs
        self._sw = None

    # ---------- addresses ----------

    def app_urls(self, ips: list[str]) -> list[str]:
        if not self.https_port:
            return []
        return [f'https://{ip}:{self.https_port}/app/' for ip in ips]

    def setup_urls(self, ips: list[str]) -> list[str]:
        return [f'http://{ip}:{self.http_port}/phone' for ip in ips] if self.https_port else []

    # ---------- requests ----------

    def handle(self, path: str, host_header: str, secure: bool, lan_addresses):
        """A Response for phone-app paths, or None to let the API/dashboard handle the request."""
        from .app import Response  # local import: app.py imports this module

        if path == '/phone':
            return Response(200, self._setup_page(host_header, lan_addresses()).encode('utf-8'),
                            [('Content-Type', 'text/html; charset=utf-8'), ('Cache-Control', 'no-cache')])
        if path == CA_PATH:
            if not self.certs:
                return Response(404, b'HTTPS is turned off on this server.', [('Content-Type', 'text/plain; charset=utf-8')])
            return Response(200, self.certs.ca_der(), [
                ('Content-Type', 'application/x-x509-ca-cert'),
                ('Content-Disposition', 'attachment; filename="gift-inventory-ca.crt"'),
                ('Cache-Control', 'no-cache'),
            ])
        if path != '/app' and not path.startswith('/app/'):
            return None

        if not secure and self.https_port:
            target = f'https://{_host_name(host_header) or "localhost"}:{self.https_port}{path}'
            return Response(302, b'', [('Location', target), ('Cache-Control', 'no-cache')])
        if path == '/app':
            return Response(302, b'', [('Location', '/app/')])
        if not self.dir:
            msg = 'The phone web app is not built yet. On a PC with Node.js run: npm run build:phone-web'
            return Response(404, msg.encode(), [('Content-Type', 'text/plain; charset=utf-8')])

        rel = path[len('/app/'):]
        if rel == 'sw.js':
            return Response(200, self._service_worker().encode('utf-8'), [
                ('Content-Type', 'text/javascript; charset=utf-8'),
                ('Cache-Control', 'no-cache'),
                ('Service-Worker-Allowed', '/app/'),
            ])
        if rel == 'manifest.webmanifest':
            return Response(200, json.dumps(_MANIFEST).encode(), [('Content-Type', 'application/manifest+json'), ('Cache-Control', 'no-cache')])

        target = os.path.realpath(os.path.join(self.dir, rel))
        if rel and target.startswith(self.dir + os.sep) and os.path.isfile(target) and not target.endswith('index.html'):
            ext = os.path.splitext(target)[1].lower()
            with open(target, 'rb') as f:
                data = f.read()
            # Bundles under _expo/static have a content hash in their name, so they never change.
            cache = 'public, max-age=31536000, immutable' if '/_expo/static/' in path else 'no-cache'
            return Response(200, data, [('Content-Type', _TYPES.get(ext, 'application/octet-stream')), ('Cache-Control', cache)])
        if os.path.splitext(rel)[1] and rel != 'index.html':
            return Response(404, b'Not found', [('Content-Type', 'text/plain; charset=utf-8')])
        return Response(200, self._index(), [('Content-Type', 'text/html; charset=utf-8'), ('Cache-Control', 'no-cache')])

    # ---------- content ----------

    def _index(self) -> bytes:
        """index.html for any app route (the app routes itself), with the home-screen tags added."""
        with open(os.path.join(self.dir, 'index.html'), encoding='utf-8') as f:
            page = f.read()
        return page.replace('</head>', _HEAD + '</head>', 1).encode('utf-8')

    def _files(self) -> list[str]:
        out = []
        for root, _, names in os.walk(self.dir):
            for n in names:
                rel = os.path.relpath(os.path.join(root, n), self.dir).replace(os.sep, '/')
                if rel not in ('index.html', 'metadata.json') and not rel.endswith('.map'):
                    out.append(rel)
        return sorted(out)

    def _service_worker(self) -> str:
        files = self._files()
        stamp = hashlib.sha256()
        for rel in files + ['index.html']:
            st = os.stat(os.path.join(self.dir, rel))
            stamp.update(f'{rel}:{st.st_size}:{st.st_mtime_ns};'.encode())
        urls = ['/app/', '/app/index.html', '/app/manifest.webmanifest'] + [f'/app/{r}' for r in files]
        return _SW % {'version': json.dumps(stamp.hexdigest()[:12]), 'files': json.dumps(urls)}

    def _setup_page(self, host_header: str, ips: list[str]) -> str:
        host = _host_name(host_header) or (ips[0] if ips else 'this-pc')
        esc = html.escape
        if not self.https_port:
            body = '<p>HTTPS is turned off on this server, so the phone web app is not available.</p>'
        else:
            app_url = f'https://{host}:{self.https_port}/app/'
            body = f"""
<p>Use these steps once on each phone. The phone must be on the office Wi-Fi.</p>

<h2>1. Install the security certificate</h2>
<p><a class="button" href="{CA_PATH}">Download certificate</a></p>
<details open><summary><b>iPhone</b></summary><ol>
<li>Open this page in <b>Safari</b> and tap <b>Download certificate</b>, then <b>Allow</b>.</li>
<li>Open <b>Settings</b>. Tap <b>Profile Downloaded</b> near the top (or <b>General → VPN &amp; Device Management</b>), then <b>Install</b> and enter the phone passcode.</li>
<li>Go to <b>Settings → General → About → Certificate Trust Settings</b> and turn on <b>Gift Inventory local CA</b>.</li>
</ol></details>
<details open><summary><b>Android</b></summary><ol>
<li>Tap <b>Download certificate</b>.</li>
<li>Open <b>Settings</b> and search for <b>CA certificate</b> (usually <b>Security → More security settings → Encryption &amp; credentials → Install a certificate → CA certificate</b>).</li>
<li>Tap <b>Install anyway</b> and choose <b>gift-inventory-ca.crt</b> from Downloads.</li>
</ol></details>

<h2>2. Open the app and add it to the home screen</h2>
<p><a class="button" href="{esc(app_url)}">Open Gift Inventory</a><br><small>{esc(app_url)}</small></p>
<ul>
<li><b>iPhone (Safari):</b> tap the <b>Share</b> button, then <b>Add to Home Screen</b>.</li>
<li><b>Android (Chrome):</b> tap <b>⋮</b>, then <b>Add to Home screen</b> or <b>Install app</b>.</li>
</ul>

<h2>3. Connect the phone</h2>
<p>Open <b>Gift Inventory</b> from the home screen. On the PC dashboard open <b>Devices → Pair a phone</b>, then scan the code with the app, or tap <b>Type the code instead</b>. Sign in with your username and password.</p>
"""
        return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Gift Inventory on a phone</title>
<style>
body {{ font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 16px 20px 40px; line-height: 1.5; color: #1a1a1a; }}
h1 {{ font-size: 1.4rem; }} h2 {{ font-size: 1.1rem; margin-top: 1.8em; }}
.button {{ display: inline-block; background: #2563eb; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; }}
details {{ margin: 10px 0; }} summary {{ cursor: pointer; }} small {{ color: #666; word-break: break-all; }} li {{ margin: 4px 0; }}
</style></head><body>
<h1>Set up Gift Inventory on a phone</h1>
{body}
</body></html>"""
