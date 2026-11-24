// Domain types shared by the server, dashboard and phone app.
// Vocabulary follows CONTEXT.md at the repo root.

export type Id = string; // UUID. Entries, Voids and phone-created Events get their id on the phone.
export type IsoTime = string; // ISO 8601 timestamp, e.g. "2026-11-24T15:04:05.000Z"
export type IsoDate = string; // "2026-11-24"

export type Role = 'staff' | 'admin';

export type MovementKind = 'receive' | 'issue' | 'transfer' | 'writeoff';
export type EntryKind = 'count' | MovementKind;

/** A Count or a Movement. Quantities are always in Pieces. */
export interface Entry {
  id: Id;
  kind: EntryKind;
  giftId: Id;
  /** For a Transfer this is the "from" Location. */
  locationId: Id;
  /** Only for a Transfer. */
  toLocationId?: Id | null;
  /** Pieces. Positive for Movements; zero or more for a Count. */
  quantity: number;
  /** Only (and always) for an Issue. */
  eventId?: Id | null;
  note?: string | null;
  userId: Id;
  deviceId?: Id | null;
  /** When it happened, by the recording device's clock. Entries are ordered by this. */
  occurredAt: IsoTime;
}

export interface Void {
  id: Id;
  entryId: Id;
  userId: Id;
  deviceId?: Id | null;
  reason: string;
  occurredAt: IsoTime;
}

export interface Pack {
  name: string; // e.g. "Carton"
  pieces: number; // e.g. 50
}

export interface Gift {
  id: Id;
  name: string;
  categoryId: Id | null;
  unitCost: number | null;
  lowStockThreshold: number | null;
  packs: Pack[];
  barcodes: string[];
  hasPhoto: boolean;
  archived: boolean;
}

export interface Category {
  id: Id;
  name: string;
}

export interface Location {
  id: Id;
  name: string;
  archived: boolean;
}

export interface GiftEvent {
  id: Id;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
  /** Set when an Admin closed it manually. */
  closedAt: IsoTime | null;
  /** When it closes by itself (3 days after endDate). Cleared when an Admin reopens it. */
  autoCloseAt: IsoTime | null;
  /** Set when an Admin merged this Event into another. */
  mergedIntoId: Id | null;
}

export interface User {
  id: Id;
  username: string;
  displayName: string;
  role: Role;
  disabled: boolean;
}

export interface StockLevel {
  giftId: Id;
  locationId: Id;
  pieces: number;
}

/** What a phone needs to work offline. */
export interface CatalogSnapshot {
  serverTime: IsoTime;
  gifts: Gift[];
  categories: Category[];
  locations: Location[];
  events: GiftEvent[];
  stock: StockLevel[];
}

/** New Event created on a phone. */
export interface NewEvent {
  id: Id;
  name: string;
  startDate: IsoDate;
  endDate: IsoDate;
}

/** A phone linking an unrecognised Barcode to an existing Gift. */
export interface BarcodeLink {
  id: Id;
  giftId: Id;
  code: string;
}

export interface SyncPush {
  events: NewEvent[];
  barcodeLinks?: BarcodeLink[];
  entries: Entry[];
  voids: Void[];
}

export interface SyncRejection {
  id: Id;
  reason: string;
}

export interface SyncResult {
  accepted: Id[];
  rejected: SyncRejection[];
}
