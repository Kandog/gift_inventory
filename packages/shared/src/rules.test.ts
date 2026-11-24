import { describe, expect, it } from 'vitest';
import {
  autoCloseAtFor,
  canVoid,
  eventClosedAt,
  isEventOpen,
  isLowStock,
  resolveEventId,
  validateEntry,
  type EntryLookups,
} from './rules';
import type { Entry, GiftEvent } from './types';

const lookups: EntryLookups = {
  giftExists: (id) => id === 'pen',
  locationExists: (id) => id === 'store' || id === 'booth',
  resolveEvent: (id) => (id === 'fair' ? 'fair' : null),
};

function entry(p: Partial<Entry>): Entry {
  return {
    id: 'e1',
    kind: 'receive',
    giftId: 'pen',
    locationId: 'store',
    quantity: 10,
    userId: 'u1',
    occurredAt: '2026-11-24T10:00:00Z',
    ...p,
  };
}

describe('validateEntry', () => {
  it('accepts a valid Receive', () => {
    expect(validateEntry(entry({}), lookups)).toBeNull();
  });
  it('rejects zero or fractional Movement quantities', () => {
    expect(validateEntry(entry({ quantity: 0 }), lookups)).toMatch(/quantity/i);
    expect(validateEntry(entry({ quantity: 1.5 }), lookups)).toMatch(/quantity/i);
  });
  it('allows a Count of zero but not negative', () => {
    expect(validateEntry(entry({ kind: 'count', quantity: 0 }), lookups)).toBeNull();
    expect(validateEntry(entry({ kind: 'count', quantity: -1 }), lookups)).toMatch(/quantity/i);
  });
  it('requires an existing Gift and Location', () => {
    expect(validateEntry(entry({ giftId: 'nope' }), lookups)).toMatch(/gift/i);
    expect(validateEntry(entry({ locationId: 'nope' }), lookups)).toMatch(/location/i);
  });
  it('requires an Event on an Issue, and only on an Issue', () => {
    expect(validateEntry(entry({ kind: 'issue' }), lookups)).toMatch(/event/i);
    expect(validateEntry(entry({ kind: 'issue', eventId: 'ghost' }), lookups)).toMatch(/event/i);
    expect(validateEntry(entry({ kind: 'issue', eventId: 'fair' }), lookups)).toBeNull();
    expect(validateEntry(entry({ kind: 'receive', eventId: 'fair' }), lookups)).toMatch(/event/i);
  });
  it('requires a different, existing destination on a Transfer', () => {
    expect(validateEntry(entry({ kind: 'transfer' }), lookups)).toMatch(/destination/i);
    expect(validateEntry(entry({ kind: 'transfer', toLocationId: 'store' }), lookups)).toMatch(/different/i);
    expect(validateEntry(entry({ kind: 'transfer', toLocationId: 'booth' }), lookups)).toBeNull();
  });
  it('rejects an unreadable time', () => {
    expect(validateEntry(entry({ occurredAt: 'yesterday' }), lookups)).toMatch(/time/i);
  });
});

describe('canVoid (ADR 0003)', () => {
  const e = entry({ userId: 'staff1', occurredAt: '2026-11-24T10:00:00Z' });
  it('lets Staff void their own entry within 10 minutes', () => {
    expect(canVoid({ id: 'staff1', role: 'staff' }, e, '2026-11-24T10:10:00Z')).toBe(true);
  });
  it('stops Staff after 10 minutes', () => {
    expect(canVoid({ id: 'staff1', role: 'staff' }, e, '2026-11-24T10:10:01Z')).toBe(false);
  });
  it("stops Staff voiding someone else's entry", () => {
    expect(canVoid({ id: 'staff2', role: 'staff' }, e, '2026-11-24T10:01:00Z')).toBe(false);
  });
  it('lets an Admin void anything, any time', () => {
    expect(canVoid({ id: 'boss', role: 'admin' }, e, '2027-01-01T00:00:00Z')).toBe(true);
  });
});

describe('Events', () => {
  const base: GiftEvent = {
    id: 'fair',
    name: 'Fall Career Fair',
    startDate: '2026-11-20',
    endDate: '2026-11-21',
    closedAt: null,
    autoCloseAt: autoCloseAtFor('2026-11-21'),
    mergedIntoId: null,
  };

  it('auto-closes at the end of the 3rd day after the end date', () => {
    const at = new Date(base.autoCloseAt!);
    expect([at.getFullYear(), at.getMonth() + 1, at.getDate(), at.getHours()]).toEqual([2026, 11, 25, 0]);
    expect(isEventOpen(base, new Date(2026, 10, 24, 23, 59).toISOString())).toBe(true);
    expect(isEventOpen(base, new Date(2026, 10, 25, 0, 0).toISOString())).toBe(false);
  });
  it('is closed once an Admin closes it, whichever comes first', () => {
    const closed = { ...base, closedAt: '2026-11-22T12:00:00Z' };
    expect(isEventOpen(closed, '2026-11-22T13:00:00Z')).toBe(false);
    expect(eventClosedAt(closed)).toBe('2026-11-22T12:00:00Z');
  });
  it('stays open after an Admin reopens it (auto-close cleared)', () => {
    const reopened = { ...base, closedAt: null, autoCloseAt: null };
    expect(isEventOpen(reopened, '2027-06-01T00:00:00Z')).toBe(true);
  });
  it('follows merges to the surviving Event', () => {
    const events = new Map<string, GiftEvent>([
      ['a', { ...base, id: 'a', mergedIntoId: 'b' }],
      ['b', { ...base, id: 'b', mergedIntoId: 'c' }],
      ['c', { ...base, id: 'c' }],
    ]);
    expect(resolveEventId('a', events)).toBe('c');
    expect(resolveEventId('zzz', events)).toBeNull();
  });
});

describe('isLowStock', () => {
  it('flags at or below the threshold, and never without one', () => {
    expect(isLowStock(10, 10)).toBe(true);
    expect(isLowStock(11, 10)).toBe(false);
    expect(isLowStock(0, null)).toBe(false);
  });
});
