import type { Entry, GiftEvent, Id, IsoDate, IsoTime, Role } from './types';

export const STAFF_VOID_WINDOW_MS = 10 * 60 * 1000;
export const EVENT_AUTO_CLOSE_DAYS = 3;

export interface EntryLookups {
  giftExists(id: Id): boolean;
  locationExists(id: Id): boolean;
  /** Returns the surviving Event id (following merges), or null if unknown. */
  resolveEvent(id: Id): Id | null;
}

const KINDS = new Set(['count', 'receive', 'issue', 'transfer', 'writeoff']);

/**
 * Structural checks only. Never rejects for stock reasons (ADR 0001):
 * returns a reason string when the entry cannot be stored, or null when it is fine.
 */
export function validateEntry(e: Entry, lookups: EntryLookups): string | null {
  if (!KINDS.has(e.kind)) return `Unknown entry kind "${e.kind}"`;
  if (!Number.isInteger(e.quantity)) return 'Quantity must be a whole number of Pieces';
  if (e.kind === 'count' ? e.quantity < 0 : e.quantity <= 0) {
    return e.kind === 'count' ? 'Quantity cannot be negative' : 'Quantity must be more than zero';
  }
  if (Number.isNaN(Date.parse(e.occurredAt))) return 'Unreadable time';
  if (!lookups.giftExists(e.giftId)) return 'Unknown Gift';
  if (!lookups.locationExists(e.locationId)) return 'Unknown Location';

  if (e.kind === 'transfer') {
    if (!e.toLocationId) return 'A Transfer needs a destination Location';
    if (e.toLocationId === e.locationId) return 'A Transfer needs a different destination Location';
    if (!lookups.locationExists(e.toLocationId)) return 'Unknown destination Location';
  } else if (e.toLocationId) {
    return 'Only a Transfer has a destination Location';
  }

  if (e.kind === 'issue') {
    if (!e.eventId) return 'An Issue needs an Event';
    if (!lookups.resolveEvent(e.eventId)) return 'Unknown Event';
  } else if (e.eventId) {
    return 'Only an Issue has an Event';
  }
  return null;
}

/** ADR 0003: Admins void anything; Staff void their own entries within 10 minutes. */
export function canVoid(user: { id: Id; role: Role }, e: Pick<Entry, 'userId' | 'occurredAt'>, voidAt: IsoTime): boolean {
  if (user.role === 'admin') return true;
  if (user.id !== e.userId) return false;
  const elapsed = Date.parse(voidAt) - Date.parse(e.occurredAt);
  return elapsed >= 0 && elapsed <= STAFF_VOID_WINDOW_MS;
}

/** Local midnight at the end of the 3rd day after endDate. */
export function autoCloseAtFor(endDate: IsoDate): IsoTime {
  const [y, m, d] = endDate.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + EVENT_AUTO_CLOSE_DAYS + 1).toISOString();
}

/** The time the Event stopped being Open, or null if it is still open-ended. */
export function eventClosedAt(ev: Pick<GiftEvent, 'closedAt' | 'autoCloseAt'>): IsoTime | null {
  const times = [ev.closedAt, ev.autoCloseAt].filter((t): t is string => !!t);
  if (times.length === 0) return null;
  return times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

export function isEventOpen(ev: Pick<GiftEvent, 'closedAt' | 'autoCloseAt' | 'mergedIntoId'>, now: IsoTime): boolean {
  if (ev.mergedIntoId) return false;
  const closed = eventClosedAt(ev);
  return closed === null || Date.parse(now) < Date.parse(closed);
}

export function resolveEventId(id: Id, events: ReadonlyMap<Id, Pick<GiftEvent, 'mergedIntoId'>>): Id | null {
  let current: Id = id;
  for (let hops = 0; hops < 50; hops++) {
    const ev = events.get(current);
    if (!ev) return null;
    if (!ev.mergedIntoId) return current;
    current = ev.mergedIntoId;
  }
  return null; // merge cycle; should never happen
}

export function isLowStock(totalPieces: number, threshold: number | null): boolean {
  return threshold !== null && totalPieces <= threshold;
}
