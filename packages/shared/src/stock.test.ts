import { describe, expect, it } from 'vitest';
import { computeStockLevels, stockKey } from './stock';
import type { Entry } from './types';

let n = 0;
function entry(partial: Partial<Entry> & Pick<Entry, 'kind' | 'quantity' | 'occurredAt'>): Entry {
  n += 1;
  return {
    id: `e${n}`,
    giftId: 'pen',
    locationId: 'store',
    userId: 'u1',
    ...partial,
  };
}

function level(entries: Entry[], voided: string[] = [], gift = 'pen', loc = 'store') {
  return computeStockLevels(entries, new Set(voided)).get(stockKey(gift, loc)) ?? 0;
}

describe('computeStockLevels', () => {
  it('adds Receives and subtracts Issues and Write-offs', () => {
    const entries = [
      entry({ kind: 'receive', quantity: 500, occurredAt: '2026-11-01T09:00:00Z' }),
      entry({ kind: 'issue', quantity: 30, eventId: 'fair', occurredAt: '2026-11-02T09:00:00Z' }),
      entry({ kind: 'writeoff', quantity: 5, occurredAt: '2026-11-03T09:00:00Z' }),
    ];
    expect(level(entries)).toBe(465);
  });

  it('moves stock between Locations on a Transfer without changing the total', () => {
    const entries = [
      entry({ kind: 'receive', quantity: 100, occurredAt: '2026-11-01T09:00:00Z' }),
      entry({ kind: 'transfer', quantity: 40, toLocationId: 'booth', occurredAt: '2026-11-02T09:00:00Z' }),
    ];
    expect(level(entries, [], 'pen', 'store')).toBe(60);
    expect(level(entries, [], 'pen', 'booth')).toBe(40);
  });

  it('a Count replaces the level at that Location only', () => {
    const entries = [
      entry({ kind: 'receive', quantity: 100, occurredAt: '2026-11-01T09:00:00Z' }),
      entry({ kind: 'receive', quantity: 20, locationId: 'booth', occurredAt: '2026-11-01T09:00:00Z' }),
      entry({ kind: 'count', quantity: 42, occurredAt: '2026-11-02T09:00:00Z' }),
    ];
    expect(level(entries, [], 'pen', 'store')).toBe(42);
    expect(level(entries, [], 'pen', 'booth')).toBe(20);
  });

  it('orders by when entries happened, not the order they arrived (ADR 0001)', () => {
    // A Count at 10:00 synced late must not wipe an Issue made at 11:00.
    const issueAt11 = entry({ kind: 'issue', quantity: 2, eventId: 'fair', occurredAt: '2026-11-02T11:00:00Z' });
    const countAt10 = entry({ kind: 'count', quantity: 42, occurredAt: '2026-11-02T10:00:00Z' });
    expect(level([issueAt11, countAt10])).toBe(40);
  });

  it('allows negative stock when offline phones over-issue (ADR 0001)', () => {
    const entries = [
      entry({ kind: 'receive', quantity: 20, occurredAt: '2026-11-01T09:00:00Z' }),
      entry({ kind: 'issue', quantity: 20, eventId: 'fair', occurredAt: '2026-11-02T09:00:00Z' }),
      entry({ kind: 'issue', quantity: 20, eventId: 'fair', occurredAt: '2026-11-02T09:05:00Z' }),
    ];
    expect(level(entries)).toBe(-20);
  });

  it('ignores Voided entries (ADR 0003)', () => {
    const wrong = entry({ kind: 'issue', quantity: 300, eventId: 'fair', occurredAt: '2026-11-02T09:00:00Z' });
    const entries = [
      entry({ kind: 'receive', quantity: 500, occurredAt: '2026-11-01T09:00:00Z' }),
      wrong,
      entry({ kind: 'issue', quantity: 30, eventId: 'fair', occurredAt: '2026-11-02T09:01:00Z' }),
    ];
    expect(level(entries, [wrong.id])).toBe(470);
  });

  it('a Count at the destination after a Transfer resets the destination', () => {
    const entries = [
      entry({ kind: 'receive', quantity: 100, occurredAt: '2026-11-01T09:00:00Z' }),
      entry({ kind: 'transfer', quantity: 40, toLocationId: 'booth', occurredAt: '2026-11-02T09:00:00Z' }),
      entry({ kind: 'count', quantity: 35, locationId: 'booth', occurredAt: '2026-11-02T12:00:00Z' }),
    ];
    expect(level(entries, [], 'pen', 'booth')).toBe(35);
    expect(level(entries, [], 'pen', 'store')).toBe(60);
  });

  it('breaks exact-time ties by id so every device computes the same result', () => {
    const a = { ...entry({ kind: 'count', quantity: 10, occurredAt: '2026-11-02T09:00:00Z' }), id: 'a' };
    const b = { ...entry({ kind: 'count', quantity: 20, occurredAt: '2026-11-02T09:00:00Z' }), id: 'b' };
    expect(level([a, b])).toBe(20);
    expect(level([b, a])).toBe(20);
  });
});
