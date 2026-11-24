// Fills a fresh, empty server with demo data through its HTTP API.
// Usage: node scripts/seed-demo.mjs [http://localhost:8080]
// Creates an Admin "demo-admin" with a random password saved to data/dev-credentials.txt (git-ignored).
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:8080';
let cookie = '';

async function call(method, path, body, bearer) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(base + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data?.error}`);
  return data;
}

const { needsSetup } = await call('GET', '/api/setup/status');
if (!needsSetup) {
  console.error('This server already has Users. The demo seed only runs on an empty server.');
  process.exit(1);
}
const password = randomBytes(9).toString('base64url');
await call('POST', '/api/setup', { username: 'demo-admin', displayName: 'Demo Admin', password });
mkdirSync('data', { recursive: true });
writeFileSync('data/dev-credentials.txt', `Dashboard: ${base}\nusername: demo-admin\npassword: ${password}\n`);

const store = (await call('GET', '/api/locations'))[0];
const booth = await call('POST', '/api/locations', { name: 'Event booth' });
const cabinet = await call('POST', '/api/locations', { name: 'Office cabinet' });
const cat = {};
for (const name of ['Bags', 'Pens', 'Toys']) cat[name] = (await call('POST', '/api/categories', { name })).id;

const giftDefs = [
  ['Blue logo pen', 'Pens', 0.45, 200, [{ name: 'Box', pieces: 10 }, { name: 'Carton', pieces: 50 }], ['0812345000017']],
  ['Black gel pen', 'Pens', 0.8, 100, [{ name: 'Box', pieces: 12 }], []],
  ['Canvas tote bag', 'Bags', 2.1, 40, [{ name: 'Bundle', pieces: 10 }], ['0812345000024']],
  ['Drawstring backpack', 'Bags', 3.25, 25, [], []],
  ['Plush bear', 'Toys', 4.5, 15, [{ name: 'Case', pieces: 24 }], []],
  ['Stress ball', 'Toys', 0.9, 60, [{ name: 'Bag', pieces: 25 }], []],
  ['Yo-yo', 'Toys', 1.2, 30, [], []],
];
const gifts = {};
for (const [name, c, unitCost, lowStockThreshold, packs, barcodes] of giftDefs) {
  gifts[name] = await call('POST', '/api/gifts', { name, categoryId: cat[c], unitCost, lowStockThreshold, packs, barcodes });
}

// Pair a phone and sync entries as Staff would.
const staffPassword = randomBytes(9).toString('base64url');
await call('POST', '/api/users', { username: 'demo-staff', displayName: 'Sam (Staff)', role: 'staff', password: staffPassword });
const { code } = await call('POST', '/api/pairing');
const { deviceToken } = await call('POST', '/api/devices/pair', { code, name: "Sam's iPhone" });
const { token } = await call('POST', '/api/auth/device-login', { deviceToken, username: 'demo-staff', password: staffPassword });

const day = (offset, h) => new Date(Date.now() + offset * 86_400_000 - (new Date().getHours() - h) * 3_600_000).toISOString();
const fair = randomUUID();
const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const e = (kind, g, loc, quantity, extra = {}) => ({ id: randomUUID(), kind, giftId: gifts[g].id, locationId: loc.id, quantity, ...extra });

const entries = [
  e('receive', 'Blue logo pen', store, 1000, { occurredAt: day(-20, 9), note: 'PO 1042' }),
  e('receive', 'Black gel pen', store, 240, { occurredAt: day(-20, 9) }),
  e('receive', 'Canvas tote bag', store, 300, { occurredAt: day(-20, 10) }),
  e('receive', 'Drawstring backpack', store, 120, { occurredAt: day(-20, 10) }),
  e('receive', 'Plush bear', store, 48, { occurredAt: day(-18, 11) }),
  e('receive', 'Stress ball', store, 200, { occurredAt: day(-18, 11) }),
  e('receive', 'Yo-yo', cabinet, 40, { occurredAt: day(-18, 12) }),
  e('transfer', 'Blue logo pen', store, 300, { toLocationId: booth.id, occurredAt: day(-3, 8) }),
  e('transfer', 'Canvas tote bag', store, 100, { toLocationId: booth.id, occurredAt: day(-3, 8) }),
  e('transfer', 'Plush bear', store, 20, { toLocationId: booth.id, occurredAt: day(-3, 8) }),
  e('issue', 'Blue logo pen', booth, 260, { eventId: fair, occurredAt: day(-2, 14) }),
  e('issue', 'Canvas tote bag', booth, 85, { eventId: fair, occurredAt: day(-2, 15) }),
  e('issue', 'Plush bear', booth, 24, { eventId: fair, occurredAt: day(-1, 13) }),
  e('writeoff', 'Stress ball', store, 6, { occurredAt: day(-5, 16), note: 'Split open' }),
  e('count', 'Black gel pen', store, 228, { occurredAt: day(-1, 17) }),
];
const result = await call(
  'POST',
  '/api/sync/push',
  {
    events: [{ id: fair, name: 'Fall Career Fair', startDate: iso(new Date(today.getTime() - 2 * 86_400_000)), endDate: iso(new Date(today.getTime() - 86_400_000)) }],
    entries,
    voids: [],
  },
  token,
);
await call('POST', '/api/events', { name: 'Spring Open House', startDate: iso(new Date(today.getTime() + 30 * 86_400_000)), endDate: iso(new Date(today.getTime() + 30 * 86_400_000)) });
console.log(`Seeded: ${result.accepted.length} accepted, ${result.rejected.length} rejected`, result.rejected);
writeFileSync('data/dev-credentials.txt', `Dashboard: ${base}
Admin  username: demo-admin  password: ${password}
Staff  username: demo-staff  password: ${staffPassword}
`);
console.log('Sign-ins saved to data/dev-credentials.txt');
