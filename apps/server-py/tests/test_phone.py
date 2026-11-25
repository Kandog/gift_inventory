"""The phone web app at /app, the /phone setup page and the HTTPS certificates."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import ssl
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from cryptography import x509  # noqa: E402

from gifts_server.app import App  # noqa: E402
from gifts_server.certs import SERVER_DAYS, ensure_certs  # noqa: E402
from gifts_server.db import Db  # noqa: E402


class PhoneWebApp(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='gifts-phone-')
        self.phone = os.path.join(self.dir, 'phone')
        os.makedirs(os.path.join(self.phone, '_expo', 'static', 'js', 'web'))
        with open(os.path.join(self.phone, 'index.html'), 'w', encoding='utf-8') as f:
            f.write('<html><head><title>Gift Inventory</title></head><body><div id="root"></div></body></html>')
        with open(os.path.join(self.phone, '_expo', 'static', 'js', 'web', 'entry-abc.js'), 'w') as f:
            f.write('console.log(1)')
        with open(os.path.join(self.phone, 'zxing_reader.wasm'), 'wb') as f:
            f.write(b'\0asm')
        self.db = Db(os.path.join(self.dir, 'gifts.db'))
        self.certs = ensure_certs(self.dir, ['192.168.1.37'])
        self.app = App(self.db, self.dir, 8080, None, self.phone, 8443, self.certs)

    def tearDown(self):
        self.db.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def get(self, path, secure=True, host='192.168.1.37:8443'):
        return self.app.handle('GET', path, {'Host': host}, b'', secure=secure)

    def header(self, r, name):
        return dict(r.headers).get(name)

    def test_http_redirects_to_https(self):
        r = self.get('/app/pair', secure=False, host='192.168.1.37:8080')
        self.assertEqual(r.status, 302)
        self.assertEqual(self.header(r, 'Location'), 'https://192.168.1.37:8443/app/pair')

    def test_app_routes_get_index_with_home_screen_tags(self):
        for path in ('/app/', '/app/pair', '/app/settings'):
            r = self.get(path)
            self.assertEqual(r.status, 200)
            self.assertIn(b'rel="manifest"', r.body)
            self.assertIn(b'apple-touch-icon', r.body)

    def test_files_service_worker_and_manifest(self):
        r = self.get('/app/zxing_reader.wasm')
        self.assertEqual((r.status, self.header(r, 'Content-Type')), (200, 'application/wasm'))
        r = self.get('/app/_expo/static/js/web/entry-abc.js')
        self.assertIn('immutable', self.header(r, 'Cache-Control'))
        sw = self.get('/app/sw.js')
        self.assertEqual(sw.status, 200)
        self.assertIn(b'/app/zxing_reader.wasm', sw.body)
        self.assertIn(b'/app/_expo/static/js/web/entry-abc.js', sw.body)
        self.assertEqual(self.get('/app/manifest.webmanifest').status, 200)
        self.assertEqual(self.get('/app/missing.js').status, 404)

    def test_path_traversal_is_refused(self):
        r = self.get('/app/../gifts.db')
        self.assertNotIn(b'SQLite', r.body)

    def test_setup_page_and_certificate(self):
        page = self.get('/phone', secure=False, host='192.168.1.37:8080')
        self.assertEqual(page.status, 200)
        self.assertIn(b'https://192.168.1.37:8443/app/', page.body)
        ca = self.get('/gift-inventory-ca.crt', secure=False)
        self.assertEqual(self.header(ca, 'Content-Type'), 'application/x-x509-ca-cert')
        cert = x509.load_der_x509_certificate(ca.body)
        self.assertTrue(cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca)

    def test_api_still_works_over_https(self):
        r = self.app.handle('GET', '/api/health', {}, b'', secure=True)
        self.assertEqual(r.status, 200)


class Certificates(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='gifts-certs-')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def load(self, path):
        with open(path, 'rb') as f:
            return x509.load_pem_x509_certificate(f.read())

    def test_long_ca_and_phone_acceptable_server_cert(self):
        files = ensure_certs(self.dir, ['192.168.1.37'])
        ca, server = self.load(files.ca_crt), self.load(files.server_crt)
        self.assertGreater((ca.not_valid_after_utc - ca.not_valid_before_utc).days, 19 * 365)
        self.assertLessEqual((server.not_valid_after_utc - server.not_valid_before_utc).days, SERVER_DAYS)
        ips = [str(i) for i in server.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.IPAddress)]
        self.assertIn('192.168.1.37', ips)
        # A TLS client that trusts only the CA accepts the server certificate.
        ctx = ssl.create_default_context(cafile=files.ca_crt)
        ctx.load_verify_locations(files.ca_crt)
        server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_ctx.load_cert_chain(files.server_crt, files.server_key)

    def test_new_ip_renews_server_cert_but_keeps_ca(self):
        files = ensure_certs(self.dir, ['192.168.1.37'])
        ca_before = Path(files.ca_crt).read_bytes()
        server_before = Path(files.server_crt).read_bytes()
        ensure_certs(self.dir, ['192.168.1.37'])
        self.assertEqual(Path(files.server_crt).read_bytes(), server_before)  # nothing changed
        ensure_certs(self.dir, ['192.168.1.50'])
        self.assertNotEqual(Path(files.server_crt).read_bytes(), server_before)
        self.assertEqual(Path(files.ca_crt).read_bytes(), ca_before)


if __name__ == '__main__':
    unittest.main()
