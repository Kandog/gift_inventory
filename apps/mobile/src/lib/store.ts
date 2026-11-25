import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import {
  autoCloseAtFor,
  canVoid,
  isEventOpen,
  type BarcodeLink,
  type CatalogSnapshot,
  type Entry,
  type EntryKind,
  type GiftEvent,
  type NewEvent,
  type SyncPush,
  type SyncResult,
  type User,
  type Void,
} from '@gifts/shared';
import { HttpError, OfflineError, request } from './client';
import { KEYS, kv, secure } from './storage';

/** What the user is recording on the phone. Picked on the home screen at each app start. */
export type EntryType = EntryKind;
export const ENTRY_TYPES: { value: EntryType; label: string; hint: string }[] = [
  { value: 'count', label: 'Count', hint: 'The number you enter replaces the stock at this Location.' },
  { value: 'receive', label: 'Receive', hint: 'New stock arrived. The number is added.' },
  { value: 'issue', label: 'Issue', hint: 'Given out at an Event. The number is taken off.' },
  { value: 'transfer', label: 'Transfer', hint: 'Moved from one Location to another.' },
  { value: 'writeoff', label: 'Write-off', hint: 'Lost or damaged. The number is taken off.' },
];
const isEntryType = (v: unknown): v is EntryType => ENTRY_TYPES.some((t) => t.value === v);

type OutboxItem =
  | { id: string; userId: string; kind: 'event'; data: NewEvent }
  | { id: string; userId: string; kind: 'link'; data: BarcodeLink }
  | { id: string; userId: string; kind: 'entry'; data: Entry }
  | { id: string; userId: string; kind: 'void'; data: Void };

export interface HistoryItem {
  entry: Entry;
  /** pending: not on the server yet. cancelled: voided before it ever synced. */
  status: 'pending' | 'synced' | 'rejected' | 'cancelled' | 'void-pending' | 'voided';
  reason?: string;
}

export interface Problem {
  id: string;
  what: string;
  reason: string;
  at: string;
}

interface Prefs {
  entryType: EntryType | null;
  locationId: string | null;
}

export interface State {
  phase: 'loading' | 'unpaired' | 'signed-out' | 'ready';
  servers: string[];
  user: User | null;
  catalog: CatalogSnapshot | null;
  outbox: OutboxItem[];
  history: HistoryItem[];
  problems: Problem[];
  lastSyncAt: string | null;
  syncing: boolean;
  online: boolean | null;
  syncError: string | null;
  prefs: Prefs;
  /** The entry type question is asked once per app start. */
  typeConfirmed: boolean;
  /** The Gift picked on the home screen (by scan, search or barcode link), not saved yet. */
  pickedGiftId: string | null;
  notice: string | null;
}

let state: State = {
  phase: 'loading',
  servers: [],
  user: null,
  catalog: null,
  outbox: [],
  history: [],
  problems: [],
  lastSyncAt: null,
  syncing: false,
  online: null,
  syncError: null,
  prefs: { entryType: null, locationId: null },
  typeConfirmed: false,
  pickedGiftId: null,
  notice: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}
export const getState = () => state;

const uuid = () => Crypto.randomUUID();
const now = () => new Date().toISOString();
const MAX_HISTORY = 300;

async function persist(patch: Partial<Pick<State, 'outbox' | 'history' | 'problems' | 'prefs' | 'catalog' | 'lastSyncAt' | 'user'>>) {
  set(patch);
  await Promise.all(Object.entries(patch).map(([k, v]) => kv.set(k, v)));
}

// ---------- start-up, pairing, sign-in ----------

export async function init() {
  const [serversRaw, deviceToken, sessionToken] = await Promise.all([secure.get(KEYS.servers), secure.get(KEYS.deviceToken), secure.get(KEYS.sessionToken)]);
  const [user, catalog, outbox, history, problems, savedPrefs, lastSyncAt] = await Promise.all([
    kv.get<User | null>(KEYS.user, null),
    kv.get<CatalogSnapshot | null>(KEYS.catalog, null),
    kv.get<OutboxItem[]>(KEYS.outbox, []),
    kv.get<HistoryItem[]>(KEYS.history, []),
    kv.get<Problem[]>(KEYS.problems, []),
    kv.get<Partial<Prefs>>(KEYS.prefs, {}),
    kv.get<string | null>(KEYS.lastSyncAt, null),
  ]);
  // Older versions stored `mode: 'count' | 'movement'`; anything that is not an entry type is asked again.
  const prefs: Prefs = { entryType: isEntryType(savedPrefs.entryType) ? savedPrefs.entryType : null, locationId: savedPrefs.locationId ?? null };
  const servers: string[] = serversRaw ? JSON.parse(serversRaw) : [];
  const phase = !deviceToken || servers.length === 0 ? 'unpaired' : sessionToken && user ? 'ready' : 'signed-out';
  set({ phase, servers, user, catalog, outbox, history, problems, prefs, lastSyncAt });
  if (phase === 'ready') void syncNow();
  startAutoSync();
}

/** Accepts the JSON in a pairing QR code, or a typed server address + code. */
export async function pair(input: { qr?: string; server?: string; code?: string }, deviceName: string) {
  let servers: string[];
  let code: string;
  if (input.qr) {
    let payload: { app?: string; servers?: string[]; code?: string };
    try {
      payload = JSON.parse(input.qr);
    } catch {
      throw new Error('That is not a Gift Inventory pairing code.');
    }
    if (payload.app !== 'gift-inventory' || !payload.code || !payload.servers?.length) throw new Error('That is not a Gift Inventory pairing code.');
    servers = payload.servers;
    code = payload.code;
  } else {
    const s = (input.server ?? '').trim().replace(/\/+$/, '');
    servers = [/^https?:\/\//.test(s) ? s : `http://${s.includes(':') ? s : `${s}:8080`}`];
    code = (input.code ?? '').trim();
  }
  const { data, server } = await request<{ deviceToken: string }>(servers, 'POST', '/api/devices/pair', { body: { code, name: deviceName } });
  const ordered = [server, ...servers.filter((s) => s !== server)];
  await secure.set(KEYS.servers, JSON.stringify(ordered));
  await secure.set(KEYS.deviceToken, data.deviceToken);
  set({ servers: ordered, phase: 'signed-out' });
}

export async function login(username: string, password: string) {
  const deviceToken = await secure.get(KEYS.deviceToken);
  try {
    const { data } = await call<{ token: string; user: User }>('POST', '/api/auth/device-login', { deviceToken, username, password }, false);
    await secure.set(KEYS.sessionToken, data.token);
    await persist({ user: data.user });
    set({ phase: 'ready', typeConfirmed: false, pickedGiftId: null, notice: null });
    void syncNow();
  } catch (e) {
    if (e instanceof HttpError && /not paired|revoked/i.test(e.message)) await forgetDevice();
    throw e;
  }
}

/** Signs out but keeps unsynced entries; they sync when the same User signs in again. */
export async function logout() {
  const token = await secure.get(KEYS.sessionToken);
  if (token) call('POST', '/api/auth/logout', {}, true).catch(() => undefined);
  await secure.del(KEYS.sessionToken);
  set({ phase: 'signed-out', typeConfirmed: false, pickedGiftId: null });
}

/** Unpairs this phone. Unsynced entries are lost, so the UI warns first. */
export async function forgetDevice() {
  await Promise.all([secure.del(KEYS.deviceToken), secure.del(KEYS.sessionToken), secure.del(KEYS.servers)]);
  await Promise.all(Object.values(KEYS).map((k) => kv.del(k)));
  set({ phase: 'unpaired', servers: [], user: null, catalog: null, outbox: [], history: [], problems: [], lastSyncAt: null, typeConfirmed: false, pickedGiftId: null });
}

export async function setPrefs(patch: Partial<Prefs>) {
  await persist({ prefs: { ...state.prefs, ...patch } });
}
export const chooseEntryType = async (entryType: EntryType) => {
  await setPrefs({ entryType });
  set({ typeConfirmed: true });
};
export const pickGift = (giftId: string | null) => set({ pickedGiftId: giftId });
export const dismissNotice = () => set({ notice: null });

// ---------- recording ----------

export type NewEntry = Omit<Entry, 'id' | 'userId' | 'occurredAt' | 'deviceId'>;

export async function recordEntry(input: NewEntry): Promise<Entry> {
  const user = state.user!;
  const entry: Entry = { ...input, id: uuid(), userId: user.id, occurredAt: now() };
  await persist({
    outbox: [...state.outbox, { id: entry.id, userId: user.id, kind: 'entry', data: entry }],
    history: [{ entry, status: 'pending' as const }, ...state.history].slice(0, MAX_HISTORY),
    prefs: { ...state.prefs, locationId: input.locationId },
  });
  void syncNow();
  return entry;
}

export async function createEvent(name: string, startDate: string, endDate: string): Promise<NewEvent> {
  const ev: NewEvent = { id: uuid(), name: name.trim(), startDate, endDate };
  await persist({ outbox: [...state.outbox, { id: ev.id, userId: state.user!.id, kind: 'event', data: ev }] });
  return ev;
}

export async function linkBarcode(giftId: string, code: string) {
  const link: BarcodeLink = { id: uuid(), giftId, code: code.trim() };
  // Apply locally straight away so the next scan finds it, even offline.
  const catalog = state.catalog && {
    ...state.catalog,
    gifts: state.catalog.gifts.map((g) => (g.id === giftId && !g.barcodes.includes(link.code) ? { ...g, barcodes: [...g.barcodes, link.code] } : g)),
  };
  await persist({ outbox: [...state.outbox, { id: link.id, userId: state.user!.id, kind: 'link', data: link }], catalog });
  void syncNow();
}

export function canVoidNow(item: HistoryItem): boolean {
  if (!state.user || !['pending', 'synced'].includes(item.status)) return false;
  return canVoid(state.user, item.entry, now());
}

/** ADR 0003. An entry that never left the phone is simply cancelled; otherwise a Void is queued. */
export async function voidEntry(entryId: string, reason: string) {
  const item = state.history.find((h) => h.entry.id === entryId);
  if (!item || !canVoidNow(item)) throw new Error('This entry can no longer be voided here. Ask an Admin.');
  const queued = state.outbox.some((o) => o.kind === 'entry' && o.id === entryId);
  if (queued) {
    await persist({
      outbox: state.outbox.filter((o) => o.id !== entryId),
      history: state.history.map((h) => (h.entry.id === entryId ? { ...h, status: 'cancelled' as const, reason } : h)),
    });
    return;
  }
  const v: Void = { id: uuid(), entryId, userId: state.user!.id, reason, occurredAt: now() };
  await persist({
    outbox: [...state.outbox, { id: v.id, userId: v.userId, kind: 'void', data: v }],
    history: state.history.map((h) => (h.entry.id === entryId ? { ...h, status: 'void-pending' as const, reason } : h)),
  });
  void syncNow();
}

// ---------- derived data ----------

/** Events from the last sync plus ones created on this phone that have not synced yet. */
export function eventsFor(s: Pick<State, 'catalog' | 'outbox'>): (GiftEvent & { open: boolean; pending: boolean })[] {
  const t = now();
  const synced = (s.catalog?.events ?? []).filter((e) => !e.mergedIntoId).map((e) => ({ ...e, open: isEventOpen(e, t), pending: false }));
  const pending = s.outbox
    .filter((o): o is Extract<OutboxItem, { kind: 'event' }> => o.kind === 'event')
    .map((o) => ({ ...o.data, closedAt: null, autoCloseAt: autoCloseAtFor(o.data.endDate), mergedIntoId: null, open: true, pending: true }));
  return [...pending, ...synced];
}

export const pendingCount = (s: State) => s.outbox.filter((o) => o.userId === s.user?.id).length;

// ---------- sync ----------

async function call<T>(method: string, path: string, body: unknown, auth: boolean) {
  const token = auth ? await secure.get(KEYS.sessionToken) : null;
  const res = await request<T>(state.servers, method, path, { body, token });
  if (res.server !== state.servers[0]) {
    const ordered = [res.server, ...state.servers.filter((s) => s !== res.server)];
    await secure.set(KEYS.servers, JSON.stringify(ordered));
    set({ servers: ordered });
  }
  return res;
}

let inFlight: Promise<void> | null = null;

/** Pushes this User's outbox, then pulls a fresh catalog. Safe to call any time. */
export function syncNow(): Promise<void> {
  if (state.phase !== 'ready') return Promise.resolve();
  inFlight ??= doSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doSync() {
  set({ syncing: true });
  try {
    const userId = state.user!.id;
    const mine = state.outbox.filter((o) => o.userId === userId);
    if (mine.length) {
      const push: SyncPush = { events: [], barcodeLinks: [], entries: [], voids: [] };
      for (const o of mine) {
        if (o.kind === 'event') push.events.push(o.data);
        else if (o.kind === 'link') push.barcodeLinks!.push(o.data);
        else if (o.kind === 'entry') push.entries.push(o.data);
        else push.voids.push(o.data);
      }
      const { data: result } = await call<SyncResult>('POST', '/api/sync/push', push, true);
      await applyResult(mine, result);
    }
    const { data: catalog } = await call<CatalogSnapshot & { me: User }>('GET', '/api/sync/catalog', undefined, true);
    const { me, ...snapshot } = catalog;
    await persist({ catalog: snapshot, user: me, lastSyncAt: now() });
    set({ online: true, syncError: null });
  } catch (e) {
    if (e instanceof OfflineError) set({ online: false, syncError: null });
    else if (e instanceof HttpError && e.status === 401) {
      await secure.del(KEYS.sessionToken);
      set({ phase: 'signed-out', online: true, notice: 'You were signed out (password changed, User disabled or phone revoked). Your unsynced entries are kept.' });
    } else set({ online: true, syncError: (e as Error).message });
  } finally {
    set({ syncing: false });
  }
}

async function applyResult(sent: OutboxItem[], result: SyncResult) {
  const rejected = new Map(result.rejected.map((r) => [r.id, r.reason]));
  const done = new Set([...result.accepted, ...rejected.keys()]);
  const at = now();
  const problems = [...state.problems];
  const history = state.history.map((h): HistoryItem => {
    if (result.accepted.includes(h.entry.id) && h.status === 'pending') return { ...h, status: 'synced' };
    if (rejected.has(h.entry.id)) return { ...h, status: 'rejected', reason: rejected.get(h.entry.id) };
    return h;
  });
  for (const o of sent) {
    if (!done.has(o.id)) continue;
    if (o.kind === 'void') {
      const idx = history.findIndex((h) => h.entry.id === o.data.entryId);
      if (idx >= 0) history[idx] = rejected.has(o.id) ? { ...history[idx]!, status: 'synced', reason: `Void refused: ${rejected.get(o.id)}` } : { ...history[idx]!, status: 'voided' };
    }
    if (rejected.has(o.id)) problems.unshift({ id: o.id, what: describe(o), reason: rejected.get(o.id)!, at });
  }
  await persist({ outbox: state.outbox.filter((o) => !done.has(o.id)), history, problems: problems.slice(0, 50) });
}

function describe(o: OutboxItem): string {
  const giftName = (id: string) => state.catalog?.gifts.find((g) => g.id === id)?.name ?? 'a Gift';
  switch (o.kind) {
    case 'event':
      return `New Event “${o.data.name}”`;
    case 'link':
      return `Barcode ${o.data.code} → ${giftName(o.data.giftId)}`;
    case 'void':
      return 'Void';
    case 'entry':
      return `${o.data.kind} ${o.data.quantity} × ${giftName(o.data.giftId)}`;
  }
}

export async function clearProblems() {
  await persist({ problems: [] });
}

let autoSyncStarted = false;
function startAutoSync() {
  if (autoSyncStarted) return;
  autoSyncStarted = true;
  // Every 30 s while the app is open, and whenever it comes back to the foreground.
  setInterval(() => AppState.currentState === 'active' && void syncNow(), 30_000);
  AppState.addEventListener('change', (s) => s === 'active' && void syncNow());
}

/** For Admins on the phone: create a Gift for an unknown Barcode (needs a connection). */
export async function createGiftOnline(name: string, categoryId: string | null, barcode: string) {
  await call('POST', '/api/gifts', { name, categoryId, barcodes: [barcode] }, true);
  await syncNow();
}

export function photoSource(giftId: string): { uri: string; headers: Record<string, string> } | null {
  const token = sessionTokenCache;
  if (!state.servers[0] || !token) return null;
  return { uri: `${state.servers[0]}/api/gifts/${giftId}/photo`, headers: { Authorization: `Bearer ${token}` } };
}
let sessionTokenCache: string | null = null;
subscribe(() => {
  if (state.phase === 'ready' && !sessionTokenCache) void secure.get(KEYS.sessionToken).then((t) => (sessionTokenCache = t));
  if (state.phase !== 'ready') sessionTokenCache = null;
});
