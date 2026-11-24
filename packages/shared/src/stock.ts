import type { Entry, Id, StockLevel } from './types';

export function stockKey(giftId: Id, locationId: Id): string {
  return `${giftId}|${locationId}`;
}

/**
 * Total order used everywhere: when it happened, then id as a tie-breaker,
 * so the server and every phone compute identical Stock Levels (ADR 0001).
 */
export function compareEntries(a: Pick<Entry, 'occurredAt' | 'id'>, b: Pick<Entry, 'occurredAt' | 'id'>): number {
  const ta = Date.parse(a.occurredAt);
  const tb = Date.parse(b.occurredAt);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Replays all non-Voided entries in the order they happened.
 * A Count replaces the level at its Location; Movements add or subtract.
 * Levels may go negative (ADR 0001). Returns a map keyed by stockKey().
 */
export function computeStockLevels(entries: readonly Entry[], voidedIds: ReadonlySet<Id>): Map<string, number> {
  const levels = new Map<string, number>();
  const add = (giftId: Id, locationId: Id, delta: number) => {
    const key = stockKey(giftId, locationId);
    levels.set(key, (levels.get(key) ?? 0) + delta);
  };

  const ordered = entries.filter((e) => !voidedIds.has(e.id)).sort(compareEntries);
  for (const e of ordered) {
    switch (e.kind) {
      case 'count':
        levels.set(stockKey(e.giftId, e.locationId), e.quantity);
        break;
      case 'receive':
        add(e.giftId, e.locationId, e.quantity);
        break;
      case 'issue':
      case 'writeoff':
        add(e.giftId, e.locationId, -e.quantity);
        break;
      case 'transfer':
        add(e.giftId, e.locationId, -e.quantity);
        if (e.toLocationId) add(e.giftId, e.toLocationId, e.quantity);
        break;
    }
  }
  return levels;
}

export function toStockLevelList(levels: Map<string, number>): StockLevel[] {
  return [...levels].map(([key, pieces]) => {
    const [giftId = '', locationId = ''] = key.split('|');
    return { giftId, locationId, pieces };
  });
}
