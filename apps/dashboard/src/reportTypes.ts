import type { GiftEvent, Location } from '@gifts/shared';

export interface StockRow {
  giftId: string;
  name: string;
  category: string | null;
  archived: boolean;
  byLocation: Record<string, number>;
  total: number;
  unitCost: number | null;
  value: number | null;
  lowStockThreshold: number | null;
  low: boolean;
  negative: boolean;
}

export interface StockReport {
  locations: Location[];
  rows: StockRow[];
  totalValue: number;
}

export interface Alerts {
  lowStock: { giftId: string; name: string; total: number; threshold: number }[];
  negativeStock: { giftId: string; name: string; locationId: string; location: string; pieces: number }[];
  staleDevices: { id: string; name: string; lastSyncAt: string | null; lastUserName: string | null }[];
  backup: { lastSuccessAt: string | null; path: string | null; overdue: boolean; lastError: string | null };
}

export interface EventSummary extends GiftEvent {
  open: boolean;
  piecesIssued: number;
  cost: number;
  mergedFrom: string[];
}

export interface EventReport {
  event: GiftEvent & { open: boolean; closedAtEffective: string | null };
  lines: { giftId: string; name: string; pieces: number; unitCost: number | null; cost: number }[];
  totalPieces: number;
  totalCost: number;
  lateSyncedIssues: number;
}

export interface ActivityRow {
  id: string;
  kind: 'count' | 'receive' | 'issue' | 'transfer' | 'writeoff';
  giftId: string;
  locationId: string;
  toLocationId: string | null;
  quantity: number;
  eventId: string | null;
  note: string | null;
  userId: string;
  occurredAt: string;
  syncedAt: string;
  userName: string;
  deviceName: string | null;
  voided: { reason: string; at: string; byName: string } | null;
}

export interface DeviceInfo {
  id: string;
  name: string;
  pairedAt: string;
  lastSyncAt: string | null;
  lastUserName: string | null;
  revokedAt: string | null;
}
