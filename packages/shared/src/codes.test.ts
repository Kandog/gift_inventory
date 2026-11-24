import { describe, expect, it } from 'vitest';
import { giftLabelPayload, resolveScan, searchGifts, toPieces } from './codes';
import type { Gift } from './types';

const gift = (p: Partial<Gift>): Gift => ({
  id: 'g1',
  name: 'Blue logo pen',
  categoryId: 'pens',
  unitCost: null,
  lowStockThreshold: null,
  packs: [],
  barcodes: [],
  hasPhoto: false,
  archived: false,
  ...p,
});

describe('resolveScan', () => {
  const gifts = [gift({}), gift({ id: 'g2', name: 'Tote bag', barcodes: ['0123456789012'] })];
  it('recognises a Gift Label', () => {
    expect(resolveScan(giftLabelPayload('g1'), gifts)).toMatchObject({ type: 'gift', via: 'label', gift: { id: 'g1' } });
  });
  it('recognises a linked Barcode', () => {
    expect(resolveScan(' 0123456789012 ', gifts)).toMatchObject({ type: 'gift', via: 'barcode', gift: { id: 'g2' } });
  });
  it('reports labels and barcodes it does not know', () => {
    expect(resolveScan('GIFT:zzz', gifts)).toEqual({ type: 'unknown-label', giftId: 'zzz' });
    expect(resolveScan('999', gifts)).toEqual({ type: 'unknown-barcode', code: '999' });
  });
});

describe('searchGifts', () => {
  const gifts = [gift({}), gift({ id: 'g2', name: 'Red pen' }), gift({ id: 'g3', name: 'Old pen', archived: true })];
  it('matches every typed word, case-insensitively, skipping Archived Gifts', () => {
    expect(searchGifts('PEN blue', gifts).map((g) => g.id)).toEqual(['g1']);
    expect(searchGifts('pen', gifts).map((g) => g.id)).toEqual(['g1', 'g2']);
  });
  it('searches the Category name too', () => {
    expect(searchGifts('writing', gifts, (id) => (id === 'pens' ? 'Writing' : '')).length).toBe(2);
  });
});

it('toPieces converts Packs to Pieces', () => {
  expect(toPieces(10, 50)).toBe(500);
  expect(toPieces(7, null)).toBe(7);
});
