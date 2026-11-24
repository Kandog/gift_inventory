import { eventClosedAt, isEventOpen, isLowStock, resolveEventId, stockKey, type Id } from '@gifts/shared';
import { listDevices } from './auth.js';
import { getSetting, type Db } from './db.js';
import { listCategories, listEvents, listGifts, listLocations, stockMap } from './store.js';

export const STALE_DEVICE_DAYS = 7;
export const BACKUP_OVERDUE_DAYS = 2;

export interface StockRow {
  giftId: Id;
  name: string;
  category: string | null;
  archived: boolean;
  byLocation: Record<Id, number>;
  total: number;
  unitCost: number | null;
  value: number | null;
  lowStockThreshold: number | null;
  low: boolean;
  negative: boolean;
}

export function stockOverview(db: Db, opts: { includeArchived?: boolean } = {}) {
  const levels = stockMap(db);
  const locations = listLocations(db);
  const categories = new Map(listCategories(db).map((c) => [c.id, c.name]));
  const rows: StockRow[] = listGifts(db)
    .filter((g) => opts.includeArchived || !g.archived)
    .map((g) => {
      const byLocation: Record<Id, number> = {};
      let total = 0;
      let negative = false;
      for (const loc of locations) {
        const pieces = levels.get(stockKey(g.id, loc.id)) ?? 0;
        byLocation[loc.id] = pieces;
        total += pieces;
        if (pieces < 0) negative = true;
      }
      return {
        giftId: g.id,
        name: g.name,
        category: g.categoryId ? (categories.get(g.categoryId) ?? null) : null,
        archived: g.archived,
        byLocation,
        total,
        unitCost: g.unitCost,
        value: g.unitCost != null ? round2(g.unitCost * Math.max(total, 0)) : null,
        lowStockThreshold: g.lowStockThreshold,
        low: isLowStock(total, g.lowStockThreshold),
        negative,
      };
    });
  const totalValue = round2(rows.reduce((s, r) => s + (r.value ?? 0), 0));
  return { locations: locations.filter((l) => !l.archived || rows.some((r) => r.byLocation[l.id])), rows, totalValue };
}

export function alerts(db: Db) {
  const { rows, locations } = stockOverview(db);
  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const lowStock = rows.filter((r) => r.low).map((r) => ({ giftId: r.giftId, name: r.name, total: r.total, threshold: r.lowStockThreshold }));
  const negativeStock = rows.flatMap((r) =>
    Object.entries(r.byLocation)
      .filter(([, pieces]) => pieces < 0)
      .map(([locationId, pieces]) => ({ giftId: r.giftId, name: r.name, locationId, location: locName.get(locationId) ?? '?', pieces })),
  );
  const staleCutoff = Date.now() - STALE_DEVICE_DAYS * 86_400_000;
  const staleDevices = listDevices(db)
    .filter((d) => !d.revokedAt && (d.lastSyncAt === null || Date.parse(d.lastSyncAt) < staleCutoff))
    .map((d) => ({ id: d.id, name: d.name, lastSyncAt: d.lastSyncAt, lastUserName: d.lastUserName }));
  const lastBackupAt = getSetting(db, 'backup.lastSuccessAt');
  const backupPath = getSetting(db, 'backup.path');
  const backupOverdue = !lastBackupAt || Date.parse(lastBackupAt) < Date.now() - BACKUP_OVERDUE_DAYS * 86_400_000;
  return {
    lowStock,
    negativeStock,
    staleDevices,
    backup: { lastSuccessAt: lastBackupAt, path: backupPath, overdue: backupOverdue, lastError: getSetting(db, 'backup.lastError') },
  };
}

interface IssueRow {
  id: string;
  gift_id: string;
  quantity: number;
  event_id: string;
  synced_at: string;
  occurred_at: string;
}

function liveIssues(db: Db): IssueRow[] {
  return db
    .prepare(
      `SELECT e.id, e.gift_id, e.quantity, e.event_id, e.synced_at, e.occurred_at FROM entries e
       WHERE e.kind = 'issue' AND NOT EXISTS (SELECT 1 FROM voids v WHERE v.entry_id = e.id)`,
    )
    .all() as unknown as IssueRow[];
}

/** One line per surviving (not merged-away) Event with totals. */
export function eventSummaries(db: Db) {
  const events = listEvents(db);
  const byId = new Map(events.map((e) => [e.id, e]));
  const gifts = new Map(listGifts(db).map((g) => [g.id, g]));
  const totals = new Map<Id, { pieces: number; cost: number }>();
  for (const i of liveIssues(db)) {
    const target = resolveEventId(i.event_id, byId);
    if (!target) continue;
    const t = totals.get(target) ?? { pieces: 0, cost: 0 };
    t.pieces += i.quantity;
    t.cost += (gifts.get(i.gift_id)?.unitCost ?? 0) * i.quantity;
    totals.set(target, t);
  }
  const now = new Date().toISOString();
  return events
    .filter((e) => !e.mergedIntoId)
    .map((e) => ({
      ...e,
      open: isEventOpen(e, now),
      piecesIssued: totals.get(e.id)?.pieces ?? 0,
      cost: round2(totals.get(e.id)?.cost ?? 0),
      mergedFrom: events.filter((x) => x.mergedIntoId === e.id).map((x) => x.name),
    }));
}

export function eventReport(db: Db, eventId: Id) {
  const events = listEvents(db);
  const byId = new Map(events.map((e) => [e.id, e]));
  const target = resolveEventId(eventId, byId);
  const ev = target ? byId.get(target) : undefined;
  if (!ev) return null;
  const closedAt = eventClosedAt(ev);
  const gifts = new Map(listGifts(db).map((g) => [g.id, g]));
  const lines = new Map<Id, { giftId: Id; name: string; pieces: number; unitCost: number | null; cost: number }>();
  let lateSynced = 0;
  for (const i of liveIssues(db)) {
    if (resolveEventId(i.event_id, byId) !== ev.id) continue;
    const g = gifts.get(i.gift_id);
    const line = lines.get(i.gift_id) ?? { giftId: i.gift_id, name: g?.name ?? '?', pieces: 0, unitCost: g?.unitCost ?? null, cost: 0 };
    line.pieces += i.quantity;
    line.cost = round2(line.pieces * (line.unitCost ?? 0));
    lines.set(i.gift_id, line);
    if (closedAt && Date.parse(i.synced_at) > Date.parse(closedAt)) lateSynced += 1;
  }
  const sorted = [...lines.values()].sort((a, b) => b.pieces - a.pieces);
  return {
    event: { ...ev, open: isEventOpen(ev, new Date().toISOString()), closedAtEffective: closedAt },
    lines: sorted,
    totalPieces: sorted.reduce((s, l) => s + l.pieces, 0),
    totalCost: round2(sorted.reduce((s, l) => s + l.cost, 0)),
    lateSyncedIssues: lateSynced,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
