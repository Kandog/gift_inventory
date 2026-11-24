import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { openDb, type Db } from './db.js';
import { ensureDefaultLocation } from './store.js';

let dir: string;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;

async function call(method: string, url: string, body?: unknown, auth?: { cookie?: string; bearer?: string }) {
  const headers: Record<string, string> = {};
  if (auth?.cookie) headers.cookie = auth.cookie;
  if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, headers });
  return { status: res.statusCode, json: () => res.json(), res };
}
const admin = (method: string, url: string, body?: unknown) => call(method, url, body, { cookie: adminCookie });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gifts-test-'));
  db = openDb(join(dir, 'gifts.db'));
  ensureDefaultLocation(db);
  app = await buildApp({ db, dataDir: dir, port: 8080 });
  const setup = await call('POST', '/api/setup', { username: 'boss', displayName: 'The Boss', password: 'correct-horse' });
  expect(setup.status).toBe(200);
  adminCookie = String(setup.res.headers['set-cookie']).split(';')[0]!;
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Pairs a phone and signs a Staff User in on it, as the mobile app does. */
async function staffPhone(username = 'sam') {
  await admin('POST', '/api/users', { username, displayName: username.toUpperCase(), role: 'staff', password: 'password1' });
  const pairing = (await admin('POST', '/api/pairing')).json();
  const { deviceToken } = (await call('POST', '/api/devices/pair', { code: pairing.code, name: `${username}'s phone` })).json();
  const login = await call('POST', '/api/auth/device-login', { deviceToken, username, password: 'password1' });
  expect(login.status).toBe(200);
  const token: string = login.json().token;
  return {
    token,
    push: (body: unknown) => call('POST', '/api/sync/push', body, { bearer: token }),
    catalog: () => call('GET', '/api/sync/catalog', undefined, { bearer: token }),
  };
}

async function seed() {
  const pen = (await admin('POST', '/api/gifts', { name: 'Blue pen', unitCost: 0.5, lowStockThreshold: 50, packs: [{ name: 'Carton', pieces: 50 }] })).json();
  const store = (await admin('GET', '/api/locations')).json()[0];
  const booth = (await admin('POST', '/api/locations', { name: 'Event booth' })).json();
  return { pen, store, booth };
}

const at = (hhmm: string) => `2026-11-21T${hhmm}:00.000Z`;

describe('setup and sign-in', () => {
  it('refuses a second setup and rejects wrong passwords', async () => {
    expect((await call('POST', '/api/setup', { username: 'x', displayName: 'x', password: 'password1' })).status).toBe(409);
    expect((await call('POST', '/api/auth/login', { username: 'boss', password: 'nope' })).status).toBe(401);
  });

  it('keeps Staff out of Admin endpoints', async () => {
    const phone = await staffPhone();
    expect((await call('GET', '/api/users', undefined, { bearer: phone.token })).status).toBe(403);
  });

  it('a pairing code works only once', async () => {
    const { code } = (await admin('POST', '/api/pairing')).json();
    expect((await call('POST', '/api/devices/pair', { code, name: 'A' })).status).toBe(200);
    expect((await call('POST', '/api/devices/pair', { code, name: 'B' })).status).toBe(401);
  });

  it('revoking a Device signs its phone out', async () => {
    const phone = await staffPhone();
    const [device] = (await admin('GET', '/api/devices')).json();
    await admin('POST', `/api/devices/${device.id}/revoke`);
    expect((await phone.catalog()).status).toBe(401);
  });
});

describe('phone sync', () => {
  it('applies an offline Count at the time it was counted (ADR 0001)', async () => {
    const { pen, store } = await seed();
    const phone = await staffPhone();
    const evId = randomUUID();
    const r = await phone.push({
      events: [{ id: evId, name: 'Career Fair', startDate: '2026-11-20', endDate: '2026-11-21' }],
      entries: [
        { id: randomUUID(), kind: 'issue', giftId: pen.id, locationId: store.id, quantity: 2, eventId: evId, occurredAt: at('11:00') },
        { id: randomUUID(), kind: 'count', giftId: pen.id, locationId: store.id, quantity: 42, occurredAt: at('10:00') },
      ],
    });
    expect(r.json().rejected).toEqual([]);
    const stock = (await phone.catalog()).json().stock;
    expect(stock.find((s: { giftId: string }) => s.giftId === pen.id).pieces).toBe(40);
  });

  it('is idempotent when a phone re-sends after a dropped connection', async () => {
    const { pen, store } = await seed();
    const phone = await staffPhone();
    const batch = { entries: [{ id: randomUUID(), kind: 'receive', giftId: pen.id, locationId: store.id, quantity: 100, occurredAt: at('09:00') }] };
    await phone.push(batch);
    await phone.push(batch);
    const { rows } = (await admin('GET', '/api/reports/stock')).json();
    expect(rows[0].total).toBe(100);
  });

  it('records the signed-in User, not whatever the phone claims', async () => {
    const { pen, store } = await seed();
    const phone = await staffPhone();
    await phone.push({ entries: [{ id: randomUUID(), kind: 'receive', giftId: pen.id, locationId: store.id, quantity: 1, userId: 'someone-else', occurredAt: at('09:00') }] });
    const { rows } = (await admin('GET', '/api/entries')).json();
    expect(rows[0].userName).toBe('SAM');
    expect(rows[0].deviceName).toBe("sam's phone");
  });

  it('accepts over-issuing and flags the negative level', async () => {
    const { pen, store } = await seed();
    const phone = await staffPhone();
    const ev = (await admin('POST', '/api/events', { name: 'Fair', startDate: '2026-11-20', endDate: '2026-11-21' })).json();
    const r = await phone.push({ entries: [{ id: randomUUID(), kind: 'issue', giftId: pen.id, locationId: store.id, quantity: 5, eventId: ev.id, occurredAt: at('09:00') }] });
    expect(r.json().rejected).toEqual([]);
    const alerts = (await admin('GET', '/api/reports/alerts')).json();
    expect(alerts.negativeStock).toEqual([expect.objectContaining({ name: 'Blue pen', pieces: -5 })]);
  });

  it('rejects structurally broken entries with a reason', async () => {
    const { pen, store } = await seed();
    const phone = await staffPhone();
    const id = randomUUID();
    const r = (await phone.push({ entries: [{ id, kind: 'issue', giftId: pen.id, locationId: store.id, quantity: 5, occurredAt: at('09:00') }] })).json();
    expect(r.rejected).toEqual([{ id, reason: 'An Issue needs an Event' }]);
  });

  it('links an unknown Barcode to a Gift from the phone', async () => {
    const { pen } = await seed();
    const phone = await staffPhone();
    await phone.push({ barcodeLinks: [{ id: randomUUID(), giftId: pen.id, code: '9780201633610' }] });
    const gifts = (await phone.catalog()).json().gifts;
    expect(gifts[0].barcodes).toEqual(['9780201633610']);
  });
});

describe('Voids (ADR 0003)', () => {
  it('Staff can Void their own entry within 10 minutes but not later', async () => {
    const { pen, store } = await seed();
    const phone = await staffPhone();
    const quick = randomUUID();
    const old = randomUUID();
    const now = Date.now();
    await phone.push({
      entries: [
        { id: quick, kind: 'receive', giftId: pen.id, locationId: store.id, quantity: 300, occurredAt: new Date(now - 60_000).toISOString() },
        { id: old, kind: 'receive', giftId: pen.id, locationId: store.id, quantity: 7, occurredAt: new Date(now - 3_600_000).toISOString() },
      ],
    });
    const r = (
      await phone.push({
        voids: [
          { id: randomUUID(), entryId: quick, reason: 'typo', occurredAt: new Date(now).toISOString() },
          { id: randomUUID(), entryId: old, reason: 'typo', occurredAt: new Date(now).toISOString() },
        ],
      })
    ).json();
    expect(r.rejected).toEqual([expect.objectContaining({ reason: 'Staff can only Void within 10 minutes' })]);
    expect((await admin('GET', '/api/reports/stock')).json().rows[0].total).toBe(7);
  });

  it('Admin "Void & correct" replaces an entry atomically and keeps the history', async () => {
    const { pen, store } = await seed();
    const ev = (await admin('POST', '/api/events', { name: 'Fair', startDate: '2026-11-20', endDate: '2026-11-21' })).json();
    const phone = await staffPhone();
    const wrong = randomUUID();
    await phone.push({
      entries: [
        { id: randomUUID(), kind: 'receive', giftId: pen.id, locationId: store.id, quantity: 500, occurredAt: at('08:00') },
        { id: wrong, kind: 'issue', giftId: pen.id, locationId: store.id, quantity: 300, eventId: ev.id, occurredAt: at('09:00') },
      ],
    });
    const res = await admin('POST', `/api/entries/${wrong}/void`, {
      reason: 'Should have been 30',
      replacement: { kind: 'issue', giftId: pen.id, locationId: store.id, quantity: 30, eventId: ev.id },
    });
    expect(res.status).toBe(200);
    expect((await admin('GET', '/api/reports/stock')).json().rows[0].total).toBe(470);
    const { rows } = (await admin('GET', '/api/entries')).json();
    expect(rows).toHaveLength(3);
    expect(rows.find((r: { id: string }) => r.id === wrong).voided.reason).toBe('Should have been 30');
  });
});

describe('Events', () => {
  it('merging folds Issues into the surviving Event report', async () => {
    const { pen, store } = await seed();
    const a = (await admin('POST', '/api/events', { name: 'Career Fair', startDate: '2026-11-20', endDate: '2026-11-21' })).json();
    const b = (await admin('POST', '/api/events', { name: 'Carreer fair', startDate: '2026-11-20', endDate: '2026-11-21' })).json();
    const phone = await staffPhone();
    await phone.push({
      entries: [
        { id: randomUUID(), kind: 'issue', giftId: pen.id, locationId: store.id, quantity: 10, eventId: a.id, occurredAt: at('09:00') },
        { id: randomUUID(), kind: 'issue', giftId: pen.id, locationId: store.id, quantity: 5, eventId: b.id, occurredAt: at('09:30') },
      ],
    });
    await admin('POST', `/api/events/${b.id}/merge`, { intoId: a.id });
    const report = (await admin('GET', `/api/events/${a.id}/report`)).json();
    expect(report.totalPieces).toBe(15);
    expect(report.totalCost).toBe(7.5);
    const list = (await admin('GET', '/api/events')).json();
    expect(list.map((e: { name: string }) => e.name)).toEqual(['Career Fair']);
  });

  it('counts Issues that synced after the Event closed (decision Q16)', async () => {
    const { pen, store } = await seed();
    const ev = (await admin('POST', '/api/events', { name: 'Fair', startDate: '2026-11-20', endDate: '2026-11-21' })).json();
    await admin('POST', `/api/events/${ev.id}/close`);
    const phone = await staffPhone();
    const r = (await phone.push({ entries: [{ id: randomUUID(), kind: 'issue', giftId: pen.id, locationId: store.id, quantity: 40, eventId: ev.id, occurredAt: at('15:00') }] })).json();
    expect(r.rejected).toEqual([]);
    const report = (await admin('GET', `/api/events/${ev.id}/report`)).json();
    expect(report.totalPieces).toBe(40);
    expect(report.lateSyncedIssues).toBe(1);
  });
});

describe('import, labels and export', () => {
  it('imports Gifts from CSV and records starting stock as Counts', async () => {
    const csv = [
      'Name,Category,Unit Cost,Low Stock Threshold,Packs,Barcodes,Stock: Storeroom,Stock: Van',
      'Tote bag,Bags,2.10,20,Bundle=10,111;222,35,5',
      'Bad row,Toys,abc,,,,,',
      'Yo-yo,Toys,1,,,,12,',
    ].join('\n');
    const boundary = 'X';
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="gifts.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/gifts',
      payload,
      headers: { cookie: adminCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(200);
    const summary = res.json();
    expect(summary).toMatchObject({ created: 2, updated: 0, counts: 3 });
    expect(summary.errors).toEqual([{ row: 3, message: 'Unit Cost is not a number' }]);
    const stock = (await admin('GET', '/api/reports/stock')).json();
    const tote = stock.rows.find((r: { name: string }) => r.name === 'Tote bag');
    expect(tote.total).toBe(40);
    expect(stock.locations.map((l: { name: string }) => l.name).sort()).toEqual(['Storeroom', 'Van']);
  });

  it('renders a Gift Label PDF', async () => {
    const { pen } = await seed();
    const res = await admin('POST', '/api/labels.pdf', { items: [{ giftId: pen.id, copies: 3 }], sheet: 'a4-21', skip: 2 });
    expect(res.status).toBe(200);
    expect(res.res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('exports stock as CSV and Excel', async () => {
    await seed();
    const csv = await admin('GET', '/api/export/stock.csv');
    expect(csv.res.body).toContain('Blue pen');
    const xlsx = await admin('GET', '/api/export/activity.xlsx');
    expect(xlsx.status).toBe(200);
    expect(xlsx.res.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });
});
