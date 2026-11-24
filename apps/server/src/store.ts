import { randomUUID } from 'node:crypto';
import {
  autoCloseAtFor,
  canVoid,
  computeStockLevels,
  resolveEventId,
  toStockLevelList,
  validateEntry,
  type Category,
  type Entry,
  type Gift,
  type GiftEvent,
  type Id,
  type Location,
  type Pack,
  type Role,
  type StockLevel,
  type SyncPush,
  type SyncResult,
  type Void,
} from '@gifts/shared';
import { tx, type Db } from './db.js';

export class DomainError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface Actor {
  id: Id;
  role: Role;
  deviceId?: Id | null;
}

const nowIso = () => new Date().toISOString();

// ---------- Categories & Locations ----------

export function listCategories(db: Db): Category[] {
  return db.prepare('SELECT id, name FROM categories ORDER BY name').all() as unknown as Category[];
}

export function upsertCategoryByName(db: Db, name: string): Id {
  const clean = name.trim();
  if (!clean) throw new DomainError('Category name is required');
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(clean) as { id: string } | undefined;
  if (row) return row.id;
  const id = randomUUID();
  db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run(id, clean);
  return id;
}

export function renameCategory(db: Db, id: Id, name: string) {
  if (!name.trim()) throw new DomainError('Category name is required');
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name.trim(), id);
}

export function listLocations(db: Db): Location[] {
  const rows = db.prepare('SELECT id, name, archived FROM locations ORDER BY name').all() as {
    id: string;
    name: string;
    archived: number;
  }[];
  return rows.map((r) => ({ id: r.id, name: r.name, archived: !!r.archived }));
}

export function createLocation(db: Db, name: string): Location {
  const clean = name.trim();
  if (!clean) throw new DomainError('Location name is required');
  if (db.prepare('SELECT 1 FROM locations WHERE name = ?').get(clean)) throw new DomainError('A Location with that name already exists');
  const id = randomUUID();
  db.prepare('INSERT INTO locations (id, name) VALUES (?, ?)').run(id, clean);
  return { id, name: clean, archived: false };
}

export function updateLocation(db: Db, id: Id, patch: { name?: string; archived?: boolean }) {
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new DomainError('Location name is required');
    db.prepare('UPDATE locations SET name = ? WHERE id = ?').run(patch.name.trim(), id);
  }
  if (patch.archived !== undefined) db.prepare('UPDATE locations SET archived = ? WHERE id = ?').run(patch.archived ? 1 : 0, id);
}

/** The single default Location so a fresh install works without setup. */
export function ensureDefaultLocation(db: Db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM locations').get() as { n: number };
  if (row.n === 0) createLocation(db, 'Storeroom');
}

// ---------- Gifts ----------

interface GiftRow {
  id: string;
  name: string;
  category_id: string | null;
  unit_cost: number | null;
  low_stock_threshold: number | null;
  photo_file: string | null;
  archived: number;
}

export function listGifts(db: Db): Gift[] {
  const rows = db.prepare('SELECT * FROM gifts ORDER BY name').all() as unknown as GiftRow[];
  const packs = db.prepare('SELECT gift_id, name, pieces FROM gift_packs ORDER BY pieces').all() as {
    gift_id: string;
    name: string;
    pieces: number;
  }[];
  const codes = db.prepare('SELECT gift_id, code FROM gift_barcodes ORDER BY code').all() as { gift_id: string; code: string }[];
  const packsBy = groupBy(packs, (p) => p.gift_id);
  const codesBy = groupBy(codes, (c) => c.gift_id);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    categoryId: r.category_id,
    unitCost: r.unit_cost,
    lowStockThreshold: r.low_stock_threshold,
    hasPhoto: !!r.photo_file,
    archived: !!r.archived,
    packs: (packsBy.get(r.id) ?? []).map((p) => ({ name: p.name, pieces: p.pieces })),
    barcodes: (codesBy.get(r.id) ?? []).map((c) => c.code),
  }));
}

export function getGift(db: Db, id: Id): Gift {
  const g = listGifts(db).find((x) => x.id === id);
  if (!g) throw new DomainError('Gift not found', 404);
  return g;
}

export interface GiftInput {
  name: string;
  categoryId?: Id | null;
  unitCost?: number | null;
  lowStockThreshold?: number | null;
  packs?: Pack[];
  barcodes?: string[];
  archived?: boolean;
}

function checkGiftInput(db: Db, input: GiftInput, giftId: Id | null) {
  if (!input.name?.trim()) throw new DomainError('Gift name is required');
  if (input.unitCost != null && !(input.unitCost >= 0)) throw new DomainError('Unit cost cannot be negative');
  if (input.lowStockThreshold != null && !(Number.isInteger(input.lowStockThreshold) && input.lowStockThreshold >= 0)) {
    throw new DomainError('Low-Stock Threshold must be a whole number of Pieces');
  }
  for (const p of input.packs ?? []) {
    if (!p.name?.trim() || !Number.isInteger(p.pieces) || p.pieces < 2) {
      throw new DomainError('Each Pack needs a name and at least 2 Pieces');
    }
  }
  for (const code of input.barcodes ?? []) {
    const owner = db.prepare('SELECT gift_id FROM gift_barcodes WHERE code = ?').get(code) as { gift_id: string } | undefined;
    if (owner && owner.gift_id !== giftId) throw new DomainError(`Barcode ${code} is already linked to another Gift`);
  }
}

function writeGiftChildren(db: Db, id: Id, input: GiftInput) {
  if (input.packs) {
    db.prepare('DELETE FROM gift_packs WHERE gift_id = ?').run(id);
    for (const p of input.packs) db.prepare('INSERT INTO gift_packs (gift_id, name, pieces) VALUES (?, ?, ?)').run(id, p.name.trim(), p.pieces);
  }
  if (input.barcodes) {
    db.prepare('DELETE FROM gift_barcodes WHERE gift_id = ?').run(id);
    for (const c of new Set(input.barcodes.map((b) => b.trim()).filter(Boolean))) {
      db.prepare('INSERT INTO gift_barcodes (code, gift_id) VALUES (?, ?)').run(c, id);
    }
  }
}

export function createGift(db: Db, input: GiftInput): Gift {
  checkGiftInput(db, input, null);
  const id = randomUUID();
  tx(db, () => {
    db.prepare(
      'INSERT INTO gifts (id, name, category_id, unit_cost, low_stock_threshold, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, input.name.trim(), input.categoryId ?? null, input.unitCost ?? null, input.lowStockThreshold ?? null, input.archived ? 1 : 0, nowIso());
    writeGiftChildren(db, id, input);
  });
  return getGift(db, id);
}

export function updateGift(db: Db, id: Id, input: GiftInput): Gift {
  getGift(db, id);
  checkGiftInput(db, input, id);
  tx(db, () => {
    db.prepare('UPDATE gifts SET name = ?, category_id = ?, unit_cost = ?, low_stock_threshold = ?, archived = ? WHERE id = ?').run(
      input.name.trim(),
      input.categoryId ?? null,
      input.unitCost ?? null,
      input.lowStockThreshold ?? null,
      input.archived ? 1 : 0,
      id,
    );
    writeGiftChildren(db, id, input);
  });
  return getGift(db, id);
}

export function setGiftPhoto(db: Db, id: Id, file: string | null) {
  db.prepare('UPDATE gifts SET photo_file = ? WHERE id = ?').run(file, id);
}

export function getGiftPhotoFile(db: Db, id: Id): string | null {
  const row = db.prepare('SELECT photo_file FROM gifts WHERE id = ?').get(id) as { photo_file: string | null } | undefined;
  return row?.photo_file ?? null;
}

/** Links an unknown Barcode scanned on a phone to an existing Gift. */
export function linkBarcode(db: Db, giftId: Id, code: string) {
  const gift = getGift(db, giftId);
  updateGift(db, giftId, { ...gift, barcodes: [...gift.barcodes, code.trim()] });
}

// ---------- Events ----------

interface EventRow {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  closed_at: string | null;
  auto_close_at: string | null;
  merged_into_id: string | null;
}

const toEvent = (r: EventRow): GiftEvent => ({
  id: r.id,
  name: r.name,
  startDate: r.start_date,
  endDate: r.end_date,
  closedAt: r.closed_at,
  autoCloseAt: r.auto_close_at,
  mergedIntoId: r.merged_into_id,
});

export function listEvents(db: Db): GiftEvent[] {
  const rows = db.prepare('SELECT * FROM events ORDER BY start_date DESC, name').all() as unknown as EventRow[];
  return rows.map(toEvent);
}

export function getEvent(db: Db, id: Id): GiftEvent {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  if (!row) throw new DomainError('Event not found', 404);
  return toEvent(row);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkEventDates(start: string, end: string) {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw new DomainError('Event dates must look like 2026-11-24');
  if (end < start) throw new DomainError('An Event cannot end before it starts');
}

export function createEvent(db: Db, input: { id?: Id; name: string; startDate: string; endDate: string }, actor: Actor): GiftEvent {
  if (!input.name?.trim()) throw new DomainError('Event name is required');
  checkEventDates(input.startDate, input.endDate);
  const id = input.id ?? randomUUID();
  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  if (existing) return toEvent(existing); // idempotent re-sync from a phone
  db.prepare(
    'INSERT INTO events (id, name, start_date, end_date, auto_close_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.name.trim(), input.startDate, input.endDate, autoCloseAtFor(input.endDate), actor.id, nowIso());
  return getEvent(db, id);
}

export function updateEvent(db: Db, id: Id, input: { name: string; startDate: string; endDate: string }): GiftEvent {
  const ev = getEvent(db, id);
  if (!input.name?.trim()) throw new DomainError('Event name is required');
  checkEventDates(input.startDate, input.endDate);
  // Changing dates re-arms auto-close, unless an Admin had reopened it to stay open.
  const autoClose = ev.autoCloseAt === null && ev.closedAt === null ? null : autoCloseAtFor(input.endDate);
  db.prepare('UPDATE events SET name = ?, start_date = ?, end_date = ?, auto_close_at = ? WHERE id = ?').run(
    input.name.trim(),
    input.startDate,
    input.endDate,
    autoClose,
    id,
  );
  return getEvent(db, id);
}

export function closeEvent(db: Db, id: Id) {
  getEvent(db, id);
  db.prepare('UPDATE events SET closed_at = ? WHERE id = ?').run(nowIso(), id);
}

export function reopenEvent(db: Db, id: Id) {
  getEvent(db, id);
  db.prepare('UPDATE events SET closed_at = NULL, auto_close_at = NULL WHERE id = ?').run(id);
}

/** Folds `fromId` into `intoId`. Issues keep their original event_id and are resolved through the merge. */
export function mergeEvent(db: Db, fromId: Id, intoId: Id) {
  if (fromId === intoId) throw new DomainError('Cannot merge an Event into itself');
  getEvent(db, fromId);
  getEvent(db, intoId);
  const events = new Map(listEvents(db).map((e) => [e.id, e]));
  if (resolveEventId(intoId, events) === fromId) throw new DomainError('That merge would create a loop');
  const target = resolveEventId(intoId, events)!;
  tx(db, () => {
    db.prepare('UPDATE events SET merged_into_id = ? WHERE id = ?').run(target, fromId);
    db.prepare('UPDATE events SET merged_into_id = ? WHERE merged_into_id = ?').run(target, fromId);
  });
}

// ---------- Entries, Voids & stock ----------

interface EntryRow {
  id: string;
  kind: Entry['kind'];
  gift_id: string;
  location_id: string;
  to_location_id: string | null;
  quantity: number;
  event_id: string | null;
  note: string | null;
  user_id: string;
  device_id: string | null;
  occurred_at: string;
  synced_at: string;
}

const toEntry = (r: EntryRow): Entry => ({
  id: r.id,
  kind: r.kind,
  giftId: r.gift_id,
  locationId: r.location_id,
  toLocationId: r.to_location_id,
  quantity: r.quantity,
  eventId: r.event_id,
  note: r.note,
  userId: r.user_id,
  deviceId: r.device_id,
  occurredAt: r.occurred_at,
});

const stockCache = new WeakMap<Db, Map<string, number>>();
const invalidateStock = (db: Db) => stockCache.delete(db);

export function stockMap(db: Db): Map<string, number> {
  let cached = stockCache.get(db);
  if (!cached) {
    const rows = db.prepare('SELECT * FROM entries').all() as unknown as EntryRow[];
    const voided = db.prepare('SELECT entry_id FROM voids').all() as { entry_id: string }[];
    cached = computeStockLevels(rows.map(toEntry), new Set(voided.map((v) => v.entry_id)));
    stockCache.set(db, cached);
  }
  return cached;
}

export function stockLevels(db: Db): StockLevel[] {
  return toStockLevelList(stockMap(db));
}

function lookups(db: Db) {
  const gifts = new Set((db.prepare('SELECT id FROM gifts').all() as { id: string }[]).map((r) => r.id));
  const locations = new Set((db.prepare('SELECT id FROM locations').all() as { id: string }[]).map((r) => r.id));
  const events = new Map(listEvents(db).map((e) => [e.id, e]));
  return {
    giftExists: (id: Id) => gifts.has(id),
    locationExists: (id: Id) => locations.has(id),
    resolveEvent: (id: Id) => resolveEventId(id, events),
  };
}

function insertEntry(db: Db, e: Entry, syncedAt: string) {
  db.prepare(
    `INSERT INTO entries (id, kind, gift_id, location_id, to_location_id, quantity, event_id, note, user_id, device_id, occurred_at, occurred_ms, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.kind,
    e.giftId,
    e.locationId,
    e.toLocationId ?? null,
    e.quantity,
    e.eventId ?? null,
    e.note?.trim() || null,
    e.userId,
    e.deviceId ?? null,
    new Date(e.occurredAt).toISOString(),
    Date.parse(e.occurredAt),
    syncedAt,
  );
}

export function getEntry(db: Db, id: Id): Entry | null {
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow | undefined;
  return row ? toEntry(row) : null;
}

/**
 * Applies a batch from a phone (or the dashboard). Idempotent: re-sending the same ids is safe.
 * Events first, then entries, then Voids, so a Void can refer to an entry in the same batch.
 */
export function applySync(db: Db, actor: Actor, push: Partial<SyncPush>): SyncResult {
  const result: SyncResult = { accepted: [], rejected: [] };
  const syncedAt = nowIso();

  tx(db, () => {
    for (const ev of push.events ?? []) {
      try {
        createEvent(db, ev, actor);
        result.accepted.push(ev.id);
      } catch (err) {
        result.rejected.push({ id: ev.id, reason: (err as Error).message });
      }
    }

    for (const link of push.barcodeLinks ?? []) {
      try {
        const owner = db.prepare('SELECT gift_id FROM gift_barcodes WHERE code = ?').get(link.code?.trim() ?? '') as
          | { gift_id: string }
          | undefined;
        if (owner?.gift_id !== link.giftId) tx(db, () => linkBarcode(db, link.giftId, link.code));
        result.accepted.push(link.id);
      } catch (err) {
        result.rejected.push({ id: link.id, reason: (err as Error).message });
      }
    }

    const look = lookups(db);
    for (const raw of push.entries ?? []) {
      // The server, not the phone, decides who and which Device made it.
      const e: Entry = { ...raw, userId: actor.id, deviceId: actor.deviceId ?? null };
      if (!e.id) {
        result.rejected.push({ id: '', reason: 'Entry has no id' });
        continue;
      }
      if (getEntry(db, e.id)) {
        result.accepted.push(e.id);
        continue;
      }
      const problem = validateEntry(e, look);
      if (problem) {
        result.rejected.push({ id: e.id, reason: problem });
        continue;
      }
      insertEntry(db, e, syncedAt);
      result.accepted.push(e.id);
    }

    for (const v of push.voids ?? []) {
      const problem = applyVoid(db, actor, v, syncedAt);
      if (problem) result.rejected.push({ id: v.id, reason: problem });
      else result.accepted.push(v.id);
    }
  });

  invalidateStock(db);
  return result;
}

function applyVoid(db: Db, actor: Actor, v: Void, syncedAt: string): string | null {
  if (!v.id || !v.entryId) return 'Void is missing its id or entry';
  if (db.prepare('SELECT 1 FROM voids WHERE id = ? OR entry_id = ?').get(v.id, v.entryId)) return null; // already voided
  const entry = getEntry(db, v.entryId);
  if (!entry) return 'Unknown entry';
  if (!v.reason?.trim()) return 'A Void needs a reason';
  const at = Number.isNaN(Date.parse(v.occurredAt)) ? syncedAt : new Date(v.occurredAt).toISOString();
  if (!canVoid(actor, entry, at)) {
    return actor.id === entry.userId ? 'Staff can only Void within 10 minutes' : 'Staff can only Void their own entries';
  }
  db.prepare('INSERT INTO voids (id, entry_id, user_id, device_id, reason, occurred_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    v.id,
    v.entryId,
    actor.id,
    actor.deviceId ?? null,
    v.reason.trim(),
    at,
    syncedAt,
  );
  return null;
}

/** Dashboard "Void & correct": Voids the wrong entry and records the right one atomically. */
export function voidAndCorrect(
  db: Db,
  actor: Actor,
  entryId: Id,
  reason: string,
  replacement: Omit<Entry, 'id' | 'userId' | 'occurredAt'> | null,
) {
  const original = getEntry(db, entryId);
  if (!original) throw new DomainError('Entry not found', 404);
  const now = nowIso();
  const push: Partial<SyncPush> = {
    voids: [{ id: randomUUID(), entryId, userId: actor.id, reason, occurredAt: now }],
    entries: replacement
      ? [{ ...replacement, id: randomUUID(), userId: actor.id, occurredAt: original.occurredAt }]
      : [],
  };
  // Validate the replacement before voiding anything.
  if (replacement) {
    const problem = validateEntry(push.entries![0]!, lookups(db));
    if (problem) throw new DomainError(problem);
  }
  const res = applySync(db, actor, push);
  if (res.rejected.length) throw new DomainError(res.rejected[0]!.reason);
}

export interface ActivityRow extends Entry {
  syncedAt: string;
  userName: string;
  deviceName: string | null;
  voided: { reason: string; at: string; byName: string } | null;
}

export function listActivity(
  db: Db,
  filter: { giftId?: Id; locationId?: Id; eventId?: Id; kind?: string; from?: string; to?: string; limit?: number; offset?: number },
): { rows: ActivityRow[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.giftId) (where.push('e.gift_id = ?'), params.push(filter.giftId));
  if (filter.locationId) (where.push('(e.location_id = ? OR e.to_location_id = ?)'), params.push(filter.locationId, filter.locationId));
  if (filter.eventId) {
    const events = new Map(listEvents(db).map((e) => [e.id, e]));
    const ids = [...events.keys()].filter((id) => resolveEventId(id, events) === filter.eventId);
    where.push(`e.event_id IN (${ids.map(() => '?').join(',') || "''"})`);
    params.push(...ids);
  }
  if (filter.kind) (where.push('e.kind = ?'), params.push(filter.kind));
  if (filter.from) (where.push('e.occurred_ms >= ?'), params.push(Date.parse(filter.from)));
  if (filter.to) (where.push('e.occurred_ms < ?'), params.push(Date.parse(filter.to)));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM entries e ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT e.*, u.display_name AS user_name, d.name AS device_name,
              v.reason AS void_reason, v.occurred_at AS void_at, vu.display_name AS void_by
       FROM entries e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN devices d ON d.id = e.device_id
       LEFT JOIN voids v ON v.entry_id = e.id
       LEFT JOIN users vu ON vu.id = v.user_id
       ${clause}
       ORDER BY e.occurred_ms DESC, e.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit ?? 100, filter.offset ?? 0) as unknown as (EntryRow & {
    user_name: string;
    device_name: string | null;
    void_reason: string | null;
    void_at: string | null;
    void_by: string | null;
  })[];
  return {
    total,
    rows: rows.map((r) => ({
      ...toEntry(r),
      syncedAt: r.synced_at,
      userName: r.user_name,
      deviceName: r.device_name,
      voided: r.void_reason ? { reason: r.void_reason, at: r.void_at!, byName: r.void_by ?? '' } : null,
    })),
  };
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = map.get(k);
    if (list) list.push(it);
    else map.set(k, [it]);
  }
  return map;
}
