import type { Gift, Id } from './types';

/** What a Gift Label's QR code contains. Anything else scanned is treated as a Barcode. */
const LABEL_PREFIX = 'GIFT:';

export function giftLabelPayload(giftId: Id): string {
  return `${LABEL_PREFIX}${giftId}`;
}

export type ScanResult =
  | { type: 'gift'; gift: Gift; via: 'label' | 'barcode' }
  | { type: 'unknown-label'; giftId: Id }
  | { type: 'unknown-barcode'; code: string };

export function resolveScan(scanned: string, gifts: readonly Gift[]): ScanResult {
  const text = scanned.trim();
  if (text.toUpperCase().startsWith(LABEL_PREFIX)) {
    const giftId = text.slice(LABEL_PREFIX.length);
    const gift = gifts.find((g) => g.id === giftId);
    return gift ? { type: 'gift', gift, via: 'label' } : { type: 'unknown-label', giftId };
  }
  const gift = gifts.find((g) => g.barcodes.includes(text));
  return gift ? { type: 'gift', gift, via: 'barcode' } : { type: 'unknown-barcode', code: text };
}

/** Typed search for the phone: every word must appear in the name or category. */
export function searchGifts(query: string, gifts: readonly Gift[], categoryName: (id: Id | null) => string = () => ''): Gift[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const active = gifts.filter((g) => !g.archived);
  if (words.length === 0) return active;
  return active.filter((g) => {
    const hay = `${g.name} ${categoryName(g.categoryId)} ${g.barcodes.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Converts what the user typed on the entry screen into Pieces. */
export function toPieces(amount: number, packPieces: number | null): number {
  return packPieces ? amount * packPieces : amount;
}
