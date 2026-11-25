"""Ported from apps/server/src/app.test.ts and backup.test.ts. Run: python -m unittest discover apps/server-py/tests"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from gifts_server.app import App  # noqa: E402
from gifts_server.backup import KEEP_BACKUPS, run_backup  # noqa: E402
from gifts_server.db import Db, get_setting, set_setting  # noqa: E402
from gifts_server.store import create_location, ensure_default_location  # noqa: E402
from gifts_server.util import ms_to_iso, now_ms  # noqa: E402


def rid():
    return str(uuid.uuid4())


def at(hhmm):
    return f'2026-11-21T{hhmm}:00.000Z'


class Res:
    def __init__(self, r):
        self.status = r.status
        self.raw = r.body
        self.headers = dict(r.headers)
        self.text = r.body.decode('utf-8', errors='replace')

    def json(self):
        return json.loads(self.raw)


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='gifts-test-')
        self.db = Db(os.path.join(self.dir, 'gifts.db'))
        ensure_default_location(self.db)
        self.app = App(self.db, self.dir, 8080)
        setup = self.call('POST', '/api/setup', {'username': 'boss', 'displayName': 'The Boss', 'password': 'correct-horse'})
        self.assertEqual(setup.status, 200)
        self.cookie = setup.headers['Set-Cookie'].split(';')[0]

    def tearDown(self):
        self.db.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def call(self, method, url, body=None, cookie=None, bearer=None, raw=None, ctype=None):
        headers = {}
        if cookie:
            headers['Cookie'] = cookie
        if bearer:
            headers['Authorization'] = f'Bearer {bearer}'
        data = b''
        if raw is not None:
            data = raw.encode()
            headers['Content-Type'] = ctype
        elif body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        return Res(self.app.handle(method, url, headers, data))

    def admin(self, method, url, body=None):
        return self.call(method, url, body, cookie=self.cookie)

    def staff_phone(self, username='sam'):
        self.admin('POST', '/api/users', {'username': username, 'displayName': username.upper(), 'role': 'staff', 'password': 'password1'})
        pairing = self.admin('POST', '/api/pairing').json()
        dev = self.call('POST', '/api/devices/pair', {'code': pairing['code'], 'name': f"{username}'s phone"}).json()
        login = self.call('POST', '/api/auth/device-login', {'deviceToken': dev['deviceToken'], 'username': username, 'password': 'password1'})
        self.assertEqual(login.status, 200)
        token = login.json()['token']
        test = self

        class Phone:
            def push(self, body):
                return test.call('POST', '/api/sync/push', body, bearer=token)

            def catalog(self):
                return test.call('GET', '/api/sync/catalog', bearer=token)

        p = Phone()
        p.token = token
        return p

    def seed(self):
        pen = self.admin('POST', '/api/gifts', {'name': 'Blue pen', 'unitCost': 0.5, 'lowStockThreshold': 50, 'packs': [{'name': 'Carton', 'pieces': 50}]}).json()
        store = self.admin('GET', '/api/locations').json()[0]
        booth = self.admin('POST', '/api/locations', {'name': 'Event booth'}).json()
        return pen, store, booth

    def upload_csv(self, csv, filename='gifts.csv'):
        payload = f'--X\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: text/csv\r\n\r\n{csv}\r\n--X--\r\n'
        res = self.call('POST', '/api/import/gifts', cookie=self.cookie, raw=payload, ctype='multipart/form-data; boundary=X')
        self.assertEqual(res.status, 200, res.text)
        return res.json()


class SetupAndSignIn(Base):
    def test_refuses_second_setup_and_wrong_passwords(self):
        self.assertEqual(self.call('POST', '/api/setup', {'username': 'x', 'displayName': 'x', 'password': 'password1'}).status, 409)
        self.assertEqual(self.call('POST', '/api/auth/login', {'username': 'boss', 'password': 'nope'}).status, 401)

    def test_staff_kept_out_of_admin(self):
        phone = self.staff_phone()
        self.assertEqual(self.call('GET', '/api/users', bearer=phone.token).status, 403)

    def test_pairing_code_once(self):
        code = self.admin('POST', '/api/pairing').json()['code']
        self.assertEqual(self.call('POST', '/api/devices/pair', {'code': code, 'name': 'A'}).status, 200)
        self.assertEqual(self.call('POST', '/api/devices/pair', {'code': code, 'name': 'B'}).status, 401)

    def test_revoke_signs_phone_out(self):
        phone = self.staff_phone()
        device = self.admin('GET', '/api/devices').json()[0]
        self.admin('POST', f"/api/devices/{device['id']}/revoke")
        self.assertEqual(phone.catalog().status, 401)

    def test_unknown_api_is_404_and_needs_login(self):
        self.assertEqual(self.call('GET', '/api/nope').status, 404)
        self.assertEqual(self.call('GET', '/api/gifts').status, 401)


class PhoneSync(Base):
    def test_offline_count_applied_at_its_time(self):
        pen, store, _ = self.seed()
        phone = self.staff_phone()
        ev = rid()
        r = phone.push({
            'events': [{'id': ev, 'name': 'Career Fair', 'startDate': '2026-11-20', 'endDate': '2026-11-21'}],
            'entries': [
                {'id': rid(), 'kind': 'issue', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 2, 'eventId': ev, 'occurredAt': at('11:00')},
                {'id': rid(), 'kind': 'count', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 42, 'occurredAt': at('10:00')},
            ],
        })
        self.assertEqual(r.json()['rejected'], [])
        stock = phone.catalog().json()['stock']
        self.assertEqual(next(s for s in stock if s['giftId'] == pen['id'])['pieces'], 40)

    def test_idempotent(self):
        pen, store, _ = self.seed()
        phone = self.staff_phone()
        batch = {'entries': [{'id': rid(), 'kind': 'receive', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 100, 'occurredAt': at('09:00')}]}
        phone.push(batch)
        phone.push(batch)
        self.assertEqual(self.admin('GET', '/api/reports/stock').json()['rows'][0]['total'], 100)

    def test_records_signed_in_user(self):
        pen, store, _ = self.seed()
        phone = self.staff_phone()
        phone.push({'entries': [{'id': rid(), 'kind': 'receive', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 1, 'userId': 'someone-else', 'occurredAt': at('09:00')}]})
        rows = self.admin('GET', '/api/entries').json()['rows']
        self.assertEqual(rows[0]['userName'], 'SAM')
        self.assertEqual(rows[0]['deviceName'], "sam's phone")

    def test_over_issue_flags_negative(self):
        pen, store, _ = self.seed()
        phone = self.staff_phone()
        ev = self.admin('POST', '/api/events', {'name': 'Fair', 'startDate': '2026-11-20', 'endDate': '2026-11-21'}).json()
        r = phone.push({'entries': [{'id': rid(), 'kind': 'issue', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 5, 'eventId': ev['id'], 'occurredAt': at('09:00')}]})
        self.assertEqual(r.json()['rejected'], [])
        neg = self.admin('GET', '/api/reports/alerts').json()['negativeStock']
        self.assertEqual(len(neg), 1)
        self.assertEqual((neg[0]['name'], neg[0]['pieces']), ('Blue pen', -5))

    def test_rejects_broken_entries(self):
        pen, store, _ = self.seed()
        phone = self.staff_phone()
        i = rid()
        r = phone.push({'entries': [{'id': i, 'kind': 'issue', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 5, 'occurredAt': at('09:00')}]}).json()
        self.assertEqual(r['rejected'], [{'id': i, 'reason': 'An Issue needs an Event'}])

    def test_links_barcode(self):
        pen, _, _ = self.seed()
        phone = self.staff_phone()
        phone.push({'barcodeLinks': [{'id': rid(), 'giftId': pen['id'], 'code': '9780201633610'}]})
        self.assertEqual(phone.catalog().json()['gifts'][0]['barcodes'], ['9780201633610'])


class Voids(Base):
    def test_staff_void_window(self):
        pen, store, _ = self.seed()
        phone = self.staff_phone()
        quick, old = rid(), rid()
        now = now_ms()
        phone.push({'entries': [
            {'id': quick, 'kind': 'receive', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 300, 'occurredAt': ms_to_iso(now - 60_000)},
            {'id': old, 'kind': 'receive', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 7, 'occurredAt': ms_to_iso(now - 3_600_000)},
        ]})
        r = phone.push({'voids': [
            {'id': rid(), 'entryId': quick, 'reason': 'typo', 'occurredAt': ms_to_iso(now)},
            {'id': rid(), 'entryId': old, 'reason': 'typo', 'occurredAt': ms_to_iso(now)},
        ]}).json()
        self.assertEqual([x['reason'] for x in r['rejected']], ['Staff can only Void within 10 minutes'])
        self.assertEqual(self.admin('GET', '/api/reports/stock').json()['rows'][0]['total'], 7)

    def test_void_and_correct(self):
        pen, store, _ = self.seed()
        ev = self.admin('POST', '/api/events', {'name': 'Fair', 'startDate': '2026-11-20', 'endDate': '2026-11-21'}).json()
        phone = self.staff_phone()
        wrong = rid()
        phone.push({'entries': [
            {'id': rid(), 'kind': 'receive', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 500, 'occurredAt': at('08:00')},
            {'id': wrong, 'kind': 'issue', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 300, 'eventId': ev['id'], 'occurredAt': at('09:00')},
        ]})
        res = self.admin('POST', f'/api/entries/{wrong}/void', {
            'reason': 'Should have been 30',
            'replacement': {'kind': 'issue', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 30, 'eventId': ev['id']},
        })
        self.assertEqual(res.status, 200, res.text)
        self.assertEqual(self.admin('GET', '/api/reports/stock').json()['rows'][0]['total'], 470)
        rows = self.admin('GET', '/api/entries').json()['rows']
        self.assertEqual(len(rows), 3)
        self.assertEqual(next(r for r in rows if r['id'] == wrong)['voided']['reason'], 'Should have been 30')


class Events(Base):
    def test_merge(self):
        pen, store, _ = self.seed()
        a = self.admin('POST', '/api/events', {'name': 'Career Fair', 'startDate': '2026-11-20', 'endDate': '2026-11-21'}).json()
        b = self.admin('POST', '/api/events', {'name': 'Carreer fair', 'startDate': '2026-11-20', 'endDate': '2026-11-21'}).json()
        phone = self.staff_phone()
        phone.push({'entries': [
            {'id': rid(), 'kind': 'issue', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 10, 'eventId': a['id'], 'occurredAt': at('09:00')},
            {'id': rid(), 'kind': 'issue', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 5, 'eventId': b['id'], 'occurredAt': at('09:30')},
        ]})
        self.admin('POST', f"/api/events/{b['id']}/merge", {'intoId': a['id']})
        report = self.admin('GET', f"/api/events/{a['id']}/report").json()
        self.assertEqual(report['totalPieces'], 15)
        self.assertEqual(report['totalCost'], 7.5)
        self.assertEqual([e['name'] for e in self.admin('GET', '/api/events').json()], ['Career Fair'])

    def test_late_synced(self):
        pen, store, _ = self.seed()
        ev = self.admin('POST', '/api/events', {'name': 'Fair', 'startDate': '2026-11-20', 'endDate': '2026-11-21'}).json()
        self.admin('POST', f"/api/events/{ev['id']}/close")
        time.sleep(0.01)
        phone = self.staff_phone()
        r = phone.push({'entries': [{'id': rid(), 'kind': 'issue', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 40, 'eventId': ev['id'], 'occurredAt': at('15:00')}]}).json()
        self.assertEqual(r['rejected'], [])
        report = self.admin('GET', f"/api/events/{ev['id']}/report").json()
        self.assertEqual(report['totalPieces'], 40)
        self.assertEqual(report['lateSyncedIssues'], 1)


class ImportLabelsExport(Base):
    def test_import_csv(self):
        csv = '\n'.join([
            'Name,Category,Unit Cost,Low Stock Threshold,Packs,Barcodes,Stock: Storeroom,Stock: Van',
            'Tote bag,Bags,2.10,20,Bundle=10,111;222,35,5',
            'Bad row,Toys,abc,,,,,',
            'Yo-yo,Toys,1,,,,12,',
        ])
        s = self.upload_csv(csv)
        self.assertEqual((s['created'], s['updated'], s['counts']), (2, 0, 3))
        self.assertEqual(s['errors'], [{'row': 3, 'message': 'Unit Cost is not a number'}])
        stock = self.admin('GET', '/api/reports/stock').json()
        self.assertEqual(next(r for r in stock['rows'] if r['name'] == 'Tote bag')['total'], 40)
        self.assertEqual(sorted(l['name'] for l in stock['locations']), ['Storeroom', 'Van'])

    def test_export_round_trips(self):
        pen, store, _ = self.seed()
        ev = self.admin('POST', '/api/events', {'name': 'Fair', 'startDate': '2026-11-20', 'endDate': '2026-11-21'}).json()
        phone = self.staff_phone()
        phone.push({'entries': [
            {'id': rid(), 'kind': 'receive', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 10, 'occurredAt': at('08:00')},
            {'id': rid(), 'kind': 'issue', 'giftId': pen['id'], 'locationId': store['id'], 'quantity': 14, 'eventId': ev['id'], 'occurredAt': at('09:00')},
        ]})
        self.admin('POST', '/api/gifts', {'name': 'Tote, "canvas"', 'barcodes': ['111', '222'], 'archived': True})
        before = self.admin('GET', '/api/entries').json()['total']
        csv = self.admin('GET', '/api/export/gifts.csv').text
        self.assertEqual(csv.split('\r\n')[0], '﻿ID,Name,Category,Unit Cost,Low Stock Threshold,Packs,Barcodes,Archived,Stock: Event booth,Stock: Storeroom')
        self.assertIn(f"{pen['id']},Blue pen,,0.5,50,Carton=50,,no,0,-4", csv)
        self.assertIn('"Tote, ""canvas"""', csv)
        s = self.upload_csv(csv)
        self.assertEqual(s, {'created': 0, 'updated': 2, 'counts': 0, 'errors': []})
        self.assertEqual(self.admin('GET', '/api/entries').json()['total'], before)
        tote = next(g for g in self.admin('GET', '/api/gifts').json() if g['name'] == 'Tote, "canvas"')
        self.assertEqual((tote['barcodes'], tote['archived']), (['111', '222'], True))

    def test_reimport_edits(self):
        pen, _, _ = self.seed()
        csv = self.admin('GET', '/api/export/gifts.csv').text
        edited = csv.replace(f"{pen['id']},Blue pen,,0.5,50,Carton=50,,no,0,0", f"{pen['id']},Blue logo pen,Pens,0.55,60,Carton=50; Box=10,999,yes,120,")
        self.assertNotEqual(edited, csv)
        s = self.upload_csv(edited)
        self.assertEqual(s, {'created': 0, 'updated': 1, 'counts': 1, 'errors': []})
        g = self.admin('GET', '/api/gifts').json()[0]
        self.assertEqual((g['id'], g['name'], g['unitCost'], g['lowStockThreshold'], g['barcodes'], g['archived']),
                         (pen['id'], 'Blue logo pen', 0.55, 60, ['999'], True))
        self.assertEqual(g['packs'], [{'name': 'Box', 'pieces': 10}, {'name': 'Carton', 'pieces': 50}])
        self.assertEqual(self.admin('GET', '/api/reports/stock?archived=1').json()['rows'][0]['total'], 120)

    def test_column_case_and_unknown_ids(self):
        s = self.upload_csv('\n'.join(['id,NAME,category,stock: storeroom', ',Yo-yo,Toys,12', 'not-a-real-id,Ghost,,']))
        self.assertEqual((s['created'], s['counts']), (1, 1))
        self.assertEqual(s['errors'], [{'row': 3, 'message': 'No Gift has ID not-a-real-id. Leave ID empty to create a new Gift.'}])

    def test_template_csv(self):
        body = self.admin('GET', '/api/import/template.csv').text
        self.assertIn('ID,Name,Category,Unit Cost,Low Stock Threshold,Packs,Barcodes,Archived,Stock: Storeroom', body)
        self.assertIn('Blue logo pen', body)

    def test_labels_pdf(self):
        pen, _, _ = self.seed()
        self.admin('PUT', f"/api/gifts/{pen['id']}", {**pen, 'name': 'A very long promotional gift name that will not fit on one sticker line at all'})
        res = self.admin('POST', '/api/labels.pdf', {'items': [{'giftId': pen['id'], 'copies': 3}], 'sheet': 'a4-21', 'skip': 2})
        self.assertEqual(res.status, 200, res.text)
        self.assertEqual(res.raw[:5], b'%PDF-')

    def test_exports(self):
        self.seed()
        self.assertIn('Blue pen', self.admin('GET', '/api/export/stock.csv').text)
        x = self.admin('GET', '/api/export/activity.xlsx')
        self.assertEqual(x.status, 200)
        self.assertEqual(x.raw[:2], b'PK')

    def test_xlsx_import_round_trip(self):
        pen, _, _ = self.seed()
        data = self.admin('GET', '/api/export/gifts.xlsx').raw
        boundary = b'X'
        payload = (b'--X\r\nContent-Disposition: form-data; name="file"; filename="g.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n'
                   + data + b'\r\n--X--\r\n')
        res = Res(self.app.handle('POST', '/api/import/gifts', {'Cookie': self.cookie, 'Content-Type': 'multipart/form-data; boundary=X'}, payload))
        self.assertEqual(res.json(), {'created': 0, 'updated': 1, 'counts': 0, 'errors': []})
        del boundary


class Backups(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='gifts-backup-')
        self.db = Db(os.path.join(self.dir, 'gifts.db'))

    def tearDown(self):
        self.db.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_writes_copy_and_photos(self):
        create_location(self.db, 'Van')
        photos = os.path.join(self.dir, 'photos')
        os.makedirs(photos)
        with open(os.path.join(photos, 'a.jpg'), 'w') as f:
            f.write('x')
        target = os.path.join(self.dir, 'share')
        os.makedirs(target)
        set_setting(self.db, 'backup.path', target)
        folder = run_backup(self.db, photos)['folder']
        copy = sqlite3.connect(os.path.join(folder, 'gifts.db'))
        self.assertTrue(copy.execute("SELECT name FROM locations WHERE name = 'Van'").fetchone())
        copy.close()
        self.assertTrue(os.path.exists(os.path.join(folder, 'photos', 'a.jpg')))
        self.assertTrue(get_setting(self.db, 'backup.lastSuccessAt'))

    def test_keeps_newest(self):
        target = os.path.join(self.dir, 'share')
        os.makedirs(target)
        for i in range(KEEP_BACKUPS + 3):
            old = os.path.join(target, f'gift-inventory-2020-01-{i + 1:02d}_0200')
            os.makedirs(old)
            t = (datetime(2020, 1, 1) + timedelta(days=i)).timestamp()
            os.utime(old, (t, t))
        set_setting(self.db, 'backup.path', target)
        run_backup(self.db, os.path.join(self.dir, 'photos'))
        left = sorted(os.listdir(target))
        self.assertEqual(len(left), KEEP_BACKUPS)
        self.assertEqual(left[0], 'gift-inventory-2020-01-05_0200')

    def test_unreachable_share(self):
        set_setting(self.db, 'backup.path', os.path.join(self.dir, 'no-such-share'))
        with self.assertRaisesRegex(Exception, 'cannot be reached'):
            run_backup(self.db, os.path.join(self.dir, 'photos'))
        self.assertIn('cannot be reached', get_setting(self.db, 'backup.lastError'))


if __name__ == '__main__':
    unittest.main()
