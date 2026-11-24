import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { CatalogSnapshot, Entry, EntryKind, Id, Role, SyncPush } from '@gifts/shared';
import {
  countUsers,
  createPairingCode,
  createUser,
  listDevices,
  listUsers,
  loginDevice,
  loginWeb,
  logout,
  markDeviceSynced,
  pairDevice,
  renameDevice,
  revokeDevice,
  sessionFor,
  updateUser,
  type Session,
} from './auth.js';
import { runBackup } from './backup.js';
import { getSetting, setSetting, type Db } from './db.js';
import { renderLabelsPdf, SHEETS, type SheetKind } from './labels.js';
import { alerts, eventReport, eventSummaries, stockOverview } from './reports.js';
import { giftsTable, importGifts, importTemplate, importTemplateRows, readSpreadsheet, toCsv, toXlsx, type Cell, type Column } from './sheets.js';
import {
  applySync,
  closeEvent,
  createEvent,
  createGift,
  createLocation,
  DomainError,
  getEvent,
  getGift,
  getGiftPhotoFile,
  listActivity,
  listCategories,
  listEvents,
  listGifts,
  listLocations,
  mergeEvent,
  renameCategory,
  reopenEvent,
  setGiftPhoto,
  stockLevels,
  updateEvent,
  updateGift,
  updateLocation,
  upsertCategoryByName,
  voidAndCorrect,
  type Actor,
  type GiftInput,
} from './store.js';

export interface AppOptions {
  db: Db;
  dataDir: string;
  port: number;
  /** Built dashboard (apps/dashboard/dist). Served at / when present. */
  dashboardDir?: string;
  logger?: boolean;
}

const COOKIE = 'gifts_sid';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
}

export async function buildApp(opts: AppOptions) {
  const { db } = opts;
  const photosDir = join(opts.dataDir, 'photos');
  const app = Fastify({
    logger: opts.logger ? { level: process.env.GIFTS_LOG_LEVEL ?? 'info' } : false,
    // Phones sync every 30 s; logging every request would fill the log file.
    disableRequestLogging: process.env.GIFTS_LOG_REQUESTS !== '1',
    bodyLimit: 20 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

  app.decorateRequest('session', null);
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies[COOKIE];
    req.session = sessionFor(db, token);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) return reply.status(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server' });
  });

  const requireUser = (req: FastifyRequest): Session => {
    if (!req.session) throw new DomainError('Please sign in', 401);
    return req.session;
  };
  const requireAdmin = (req: FastifyRequest): Session => {
    const s = requireUser(req);
    if (s.user.role !== 'admin') throw new DomainError('Only an Admin can do that', 403);
    return s;
  };
  const actorOf = (s: Session): Actor => ({ id: s.user.id, role: s.user.role, deviceId: s.deviceId });

  // ---------- Public ----------

  app.get('/api/health', async () => ({ ok: true, app: 'gift-inventory', serverTime: new Date().toISOString() }));

  app.get('/api/setup/status', async () => ({ needsSetup: countUsers(db) === 0 }));

  app.post<{ Body: { username: string; displayName: string; password: string } }>('/api/setup', async (req, reply) => {
    if (countUsers(db) > 0) throw new DomainError('Setup is already done', 409);
    createUser(db, { ...req.body, role: 'admin' });
    const { token, user } = loginWeb(db, req.body.username, req.body.password);
    setCookie(reply, token);
    return { user };
  });

  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', async (req, reply) => {
    const { token, user } = loginWeb(db, req.body?.username, req.body?.password);
    setCookie(reply, token);
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies[COOKIE];
    if (token) logout(db, token);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: requireUser(req).user, deviceId: req.session?.deviceId ?? null }));

  app.post<{ Body: { code: string; name: string } }>('/api/devices/pair', async (req) => pairDevice(db, req.body?.code, req.body?.name));

  app.post<{ Body: { deviceToken: string; username: string; password: string } }>('/api/auth/device-login', async (req) =>
    loginDevice(db, req.body?.deviceToken, req.body?.username, req.body?.password),
  );

  // ---------- Phone sync (any signed-in User) ----------

  app.get('/api/sync/catalog', async (req): Promise<CatalogSnapshot & { me: Session['user'] }> => {
    const s = requireUser(req);
    if (s.deviceId) markDeviceSynced(db, s.deviceId);
    return {
      serverTime: new Date().toISOString(),
      me: s.user,
      gifts: listGifts(db),
      categories: listCategories(db),
      locations: listLocations(db),
      events: listEvents(db),
      stock: stockLevels(db),
    };
  });

  app.post<{ Body: Partial<SyncPush> }>('/api/sync/push', async (req) => {
    const s = requireUser(req);
    const result = applySync(db, actorOf(s), req.body ?? {});
    if (s.deviceId) markDeviceSynced(db, s.deviceId);
    return result;
  });

  app.get<{ Params: { id: string } }>('/api/gifts/:id/photo', async (req, reply) => {
    requireUser(req);
    const file = getGiftPhotoFile(db, req.params.id);
    if (!file || !existsSync(join(photosDir, file))) throw new DomainError('No photo', 404);
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.type(file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    return readFile(join(photosDir, file));
  });

  // Recent activity is useful to Staff on the phone too (e.g. to Void their own typo).
  app.get<{ Querystring: Record<string, string> }>('/api/entries', async (req) => {
    requireUser(req);
    const q = req.query;
    return listActivity(db, {
      giftId: q.giftId,
      locationId: q.locationId,
      eventId: q.eventId,
      kind: q.kind,
      from: q.from,
      to: q.to,
      limit: clampInt(q.limit, 100, 1, 1000),
      offset: clampInt(q.offset, 0, 0, 1e9),
    });
  });

  // ---------- Admin: Gifts, Categories, Locations ----------

  app.get('/api/gifts', async (req) => (requireAdmin(req), listGifts(db)));
  app.post<{ Body: GiftInput }>('/api/gifts', async (req) => (requireAdmin(req), createGift(db, req.body)));
  app.put<{ Params: { id: string }; Body: GiftInput }>('/api/gifts/:id', async (req) => (requireAdmin(req), updateGift(db, req.params.id, req.body)));

  app.post<{ Params: { id: string } }>('/api/gifts/:id/photo', async (req) => {
    requireAdmin(req);
    getGift(db, req.params.id);
    const file = await req.file();
    if (!file) throw new DomainError('No file uploaded');
    const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : file.mimetype === 'image/jpeg' ? 'jpg' : null;
    if (!ext) throw new DomainError('Photo must be a JPEG, PNG or WebP image');
    await mkdir(photosDir, { recursive: true });
    const old = getGiftPhotoFile(db, req.params.id);
    const name = `${req.params.id}-${Date.now()}.${ext}`;
    await writeFile(join(photosDir, name), await file.toBuffer());
    setGiftPhoto(db, req.params.id, name);
    if (old) await rm(join(photosDir, old), { force: true });
    return getGift(db, req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/gifts/:id/photo', async (req) => {
    requireAdmin(req);
    const old = getGiftPhotoFile(db, req.params.id);
    setGiftPhoto(db, req.params.id, null);
    if (old) await rm(join(photosDir, old), { force: true });
    return getGift(db, req.params.id);
  });

  app.get('/api/categories', async (req) => (requireUser(req), listCategories(db)));
  app.post<{ Body: { name: string } }>('/api/categories', async (req) => {
    requireAdmin(req);
    const id = upsertCategoryByName(db, req.body?.name ?? '');
    return listCategories(db).find((c) => c.id === id);
  });
  app.put<{ Params: { id: string }; Body: { name: string } }>('/api/categories/:id', async (req) => {
    requireAdmin(req);
    renameCategory(db, req.params.id, req.body?.name ?? '');
    return { ok: true };
  });

  app.get('/api/locations', async (req) => (requireUser(req), listLocations(db)));
  app.post<{ Body: { name: string } }>('/api/locations', async (req) => (requireAdmin(req), createLocation(db, req.body?.name ?? '')));
  app.put<{ Params: { id: string }; Body: { name?: string; archived?: boolean } }>('/api/locations/:id', async (req) => {
    requireAdmin(req);
    updateLocation(db, req.params.id, req.body ?? {});
    return { ok: true };
  });

  // ---------- Admin: Events ----------

  app.get('/api/events', async (req) => (requireUser(req), eventSummaries(db)));
  app.post<{ Body: { name: string; startDate: string; endDate: string } }>('/api/events', async (req) =>
    createEvent(db, req.body, actorOf(requireUser(req))),
  );
  app.put<{ Params: { id: string }; Body: { name: string; startDate: string; endDate: string } }>('/api/events/:id', async (req) => {
    requireAdmin(req);
    return updateEvent(db, req.params.id, req.body);
  });
  app.post<{ Params: { id: string } }>('/api/events/:id/close', async (req) => (requireAdmin(req), closeEvent(db, req.params.id), getEvent(db, req.params.id)));
  app.post<{ Params: { id: string } }>('/api/events/:id/reopen', async (req) => (requireAdmin(req), reopenEvent(db, req.params.id), getEvent(db, req.params.id)));
  app.post<{ Params: { id: string }; Body: { intoId: string } }>('/api/events/:id/merge', async (req) => {
    requireAdmin(req);
    mergeEvent(db, req.params.id, req.body?.intoId);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/events/:id/report', async (req) => {
    requireAdmin(req);
    const report = eventReport(db, req.params.id);
    if (!report) throw new DomainError('Event not found', 404);
    return report;
  });

  // ---------- Admin: entries ----------

  app.post<{ Body: Omit<Entry, 'userId'> }>('/api/entries', async (req) => {
    const s = requireAdmin(req);
    const res = applySync(db, actorOf(s), { entries: [{ ...req.body, userId: s.user.id }] });
    if (res.rejected.length) throw new DomainError(res.rejected[0]!.reason);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { reason: string; replacement?: Omit<Entry, 'id' | 'userId' | 'occurredAt'> | null } }>(
    '/api/entries/:id/void',
    async (req) => {
      const s = requireUser(req);
      voidAndCorrect(db, actorOf(s), req.params.id, req.body?.reason ?? '', req.body?.replacement ?? null);
      return { ok: true };
    },
  );

  // ---------- Admin: Users & Devices ----------

  app.get('/api/users', async (req) => (requireAdmin(req), listUsers(db)));
  app.post<{ Body: { username: string; displayName: string; role: Role; password: string } }>('/api/users', async (req) => (requireAdmin(req), createUser(db, req.body)));
  app.put<{ Params: { id: string }; Body: { displayName?: string; role?: Role; disabled?: boolean; password?: string } }>('/api/users/:id', async (req) => {
    requireAdmin(req);
    updateUser(db, req.params.id, req.body ?? {});
    return { ok: true };
  });

  app.get('/api/devices', async (req) => (requireAdmin(req), listDevices(db)));
  app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', async (req) => (requireAdmin(req), revokeDevice(db, req.params.id), { ok: true }));
  app.put<{ Params: { id: string }; Body: { name: string } }>('/api/devices/:id', async (req) => (requireAdmin(req), renameDevice(db, req.params.id, req.body?.name), { ok: true }));

  /** A one-time pairing code plus every address phones could use to reach this PC. */
  app.post('/api/pairing', async (req) => {
    const s = requireAdmin(req);
    const { code, expiresAt } = createPairingCode(db, s.user.id);
    const servers = lanAddresses().map((ip) => `http://${ip}:${opts.port}`);
    return { code, expiresAt, servers, qr: JSON.stringify({ app: 'gift-inventory', v: 1, servers, code }) };
  });

  // ---------- Reports & exports ----------

  app.get('/api/reports/alerts', async (req) => (requireAdmin(req), alerts(db)));
  app.get<{ Querystring: { archived?: string } }>('/api/reports/stock', async (req) =>
    (requireAdmin(req), stockOverview(db, { includeArchived: req.query.archived === '1' })),
  );

  app.get<{ Params: { report: string; format: string }; Querystring: Record<string, string> }>(
    '/api/export/:report.:format',
    async (req, reply) => {
      requireAdmin(req);
      const { report, format } = req.params;
      if (format !== 'xlsx' && format !== 'csv') throw new DomainError('Format must be xlsx or csv', 404);
      const table = exportTable(db, report, req.query);
      const filename = `${table.name}-${new Date().toISOString().slice(0, 10)}.${format}`;
      reply.header('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]+/g, '_')}"`);
      if (format === 'csv') return reply.type('text/csv; charset=utf-8').send(toCsv(table.columns, table.rows));
      return reply
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(await toXlsx(table.name, table.columns, table.rows));
    },
  );

  // ---------- Import & labels ----------

  app.get('/api/import/template.xlsx', async (req, reply) => {
    requireAdmin(req);
    reply.header('Content-Disposition', 'attachment; filename="gift-import-template.xlsx"');
    return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await importTemplate(db));
  });

  app.get('/api/import/template.csv', async (req, reply) => {
    requireAdmin(req);
    const t = importTemplateRows(db);
    reply.header('Content-Disposition', 'attachment; filename="gift-import-template.csv"');
    return reply.type('text/csv; charset=utf-8').send(toCsv(t.columns, t.rows));
  });

  app.post('/api/import/gifts', async (req) => {
    const s = requireAdmin(req);
    const file = await req.file();
    if (!file) throw new DomainError('No file uploaded');
    if (!/\.(xlsx|csv)$/i.test(file.filename)) throw new DomainError('Upload an .xlsx or .csv file');
    const rows = await readSpreadsheet(await file.toBuffer(), file.filename);
    return importGifts(db, actorOf(s), rows);
  });

  app.post<{ Body: { items: { giftId: Id; copies: number }[]; sheet: SheetKind; skip?: number } }>('/api/labels.pdf', async (req, reply) => {
    requireAdmin(req);
    const { items = [], sheet = 'letter-30', skip = 0 } = req.body ?? {};
    if (!(sheet in SHEETS)) throw new DomainError('Unknown sticker sheet');
    const gifts = new Map(listGifts(db).map((g) => [g.id, g]));
    const cats = new Map(listCategories(db).map((c) => [c.id, c.name]));
    const requests = items.flatMap((it) => {
      const gift = gifts.get(it.giftId);
      return gift ? [{ gift, category: gift.categoryId ? (cats.get(gift.categoryId) ?? null) : null, copies: clampInt(String(it.copies), 1, 1, 500) }] : [];
    });
    if (!requests.length) throw new DomainError('Choose at least one Gift');
    reply.header('Content-Disposition', 'inline; filename="gift-labels.pdf"');
    return reply.type('application/pdf').send(await renderLabelsPdf(requests, sheet, skip));
  });

  // ---------- Settings & backup ----------

  app.get('/api/settings', async (req) => {
    requireAdmin(req);
    return {
      backupPath: getSetting(db, 'backup.path') ?? '',
      lastBackupAt: getSetting(db, 'backup.lastSuccessAt'),
      lastBackupFolder: getSetting(db, 'backup.lastFolder'),
      lastBackupError: getSetting(db, 'backup.lastError') || null,
      dataDir: opts.dataDir,
      addresses: lanAddresses().map((ip) => `http://${ip}:${opts.port}`),
    };
  });
  app.put<{ Body: { backupPath: string } }>('/api/settings', async (req) => {
    requireAdmin(req);
    setSetting(db, 'backup.path', (req.body?.backupPath ?? '').trim());
    return { ok: true };
  });
  app.post('/api/backup/run', async (req) => {
    requireAdmin(req);
    try {
      return await runBackup(db, photosDir);
    } catch (err) {
      throw new DomainError((err as Error).message);
    }
  });

  // ---------- Dashboard (static SPA) ----------

  if (opts.dashboardDir && existsSync(opts.dashboardDir)) {
    await app.register(fastifyStatic, { root: opts.dashboardDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

function setCookie(reply: FastifyReply, token: string) {
  // Private LAN over plain HTTP, so no `secure` flag. 180 days; the dashboard stays signed in.
  reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 180 * 86_400 });
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    // Skip 169.254.x.x: Windows' self-assigned "no network" address, unreachable from phones.
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
  }
  // Typical home/office ranges first.
  return out.sort((a, b) => rank(a) - rank(b));
}
const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);

function clampInt(v: string | undefined, dflt: number, min: number, max: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
}

const KIND_LABEL: Record<EntryKind, string> = {
  count: 'Count',
  receive: 'Receive',
  issue: 'Issue',
  transfer: 'Transfer',
  writeoff: 'Write-off',
};

function exportTable(db: Db, report: string, q: Record<string, string>): { name: string; columns: Column[]; rows: Record<string, Cell>[] } {
  if (report === 'gifts') return giftsTable(db); // same format the Gift import reads
  if (report === 'stock') {
    const s = stockOverview(db);
    return {
      name: 'stock',
      columns: [
        { header: 'Gift', key: 'name', width: 30 },
        { header: 'Category', key: 'category' },
        ...s.locations.map((l) => ({ header: l.name, key: `loc:${l.id}` })),
        { header: 'Total', key: 'total' },
        { header: 'Unit cost', key: 'unitCost' },
        { header: 'Value', key: 'value' },
        { header: 'Low-Stock Threshold', key: 'lowStockThreshold' },
        { header: 'Status', key: 'status' },
      ],
      rows: s.rows.map((r) => ({
        ...r,
        ...Object.fromEntries(Object.entries(r.byLocation).map(([k, v]) => [`loc:${k}`, v])),
        status: r.negative ? 'Negative' : r.low ? 'Low' : '',
      })),
    } as never;
  }
  if (report === 'events') {
    return {
      name: 'events',
      columns: [
        { header: 'Event', key: 'name', width: 30 },
        { header: 'Start', key: 'startDate' },
        { header: 'End', key: 'endDate' },
        { header: 'Status', key: 'status' },
        { header: 'Pieces issued', key: 'piecesIssued' },
        { header: 'Cost', key: 'cost' },
      ],
      rows: eventSummaries(db).map((e) => ({ ...e, status: e.open ? 'Open' : 'Closed' })) as never,
    };
  }
  if (report === 'event') {
    const r = eventReport(db, q.id ?? '');
    if (!r) throw new DomainError('Event not found', 404);
    return {
      name: `event-${r.event.name}`,
      columns: [
        { header: 'Gift', key: 'name', width: 30 },
        { header: 'Pieces issued', key: 'pieces' },
        { header: 'Unit cost', key: 'unitCost' },
        { header: 'Cost', key: 'cost' },
      ],
      rows: r.lines,
    };
  }
  if (report === 'activity') {
    const gifts = new Map(listGifts(db).map((g) => [g.id, g.name]));
    const locs = new Map(listLocations(db).map((l) => [l.id, l.name]));
    const events = new Map(listEvents(db).map((e) => [e.id, e.name]));
    const { rows } = listActivity(db, { ...q, limit: 100_000 });
    return {
      name: 'activity',
      columns: [
        { header: 'When', key: 'occurredAt', width: 22 },
        { header: 'Type', key: 'kindLabel' },
        { header: 'Gift', key: 'gift', width: 30 },
        { header: 'Location', key: 'location' },
        { header: 'To Location', key: 'toLocation' },
        { header: 'Pieces', key: 'quantity' },
        { header: 'Event', key: 'event' },
        { header: 'Note', key: 'note' },
        { header: 'User', key: 'userName' },
        { header: 'Device', key: 'deviceName' },
        { header: 'Synced', key: 'syncedAt', width: 22 },
        { header: 'Voided', key: 'voidedText', width: 30 },
      ],
      rows: rows.map((r) => ({
        ...r,
        kindLabel: KIND_LABEL[r.kind],
        gift: gifts.get(r.giftId),
        location: locs.get(r.locationId),
        toLocation: r.toLocationId ? locs.get(r.toLocationId) : '',
        event: r.eventId ? events.get(r.eventId) : '',
        voidedText: r.voided ? `${r.voided.byName}: ${r.voided.reason}` : '',
      })) as never,
    };
  }
  throw new DomainError('Unknown report', 404);
}
