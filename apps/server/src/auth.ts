import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Id, Role, User } from '@gifts/shared';
import type { Db } from './db.js';
import { DomainError } from './store.js';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const nowIso = () => new Date().toISOString();

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
  disabled: number;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  role: r.role,
  disabled: !!r.disabled,
});

export function countUsers(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function listUsers(db: Db): User[] {
  return (db.prepare('SELECT * FROM users ORDER BY display_name').all() as unknown as UserRow[]).map(toUser);
}

function checkPassword(password: string) {
  if (!password || password.length < 8) throw new DomainError('Password must be at least 8 characters');
}

export function createUser(db: Db, input: { username: string; displayName: string; role: Role; password: string }): User {
  const username = input.username?.trim();
  if (!username || !/^[A-Za-z0-9._-]{2,40}$/.test(username)) {
    throw new DomainError('Username must be 2–40 letters, digits, dots, dashes or underscores');
  }
  if (!input.displayName?.trim()) throw new DomainError('Display name is required');
  if (input.role !== 'staff' && input.role !== 'admin') throw new DomainError('Role must be staff or admin');
  checkPassword(input.password);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new DomainError('That username is taken');
  const id = randomUUID();
  db.prepare('INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    username,
    input.displayName.trim(),
    input.role,
    hashPassword(input.password),
    nowIso(),
  );
  return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow);
}

export function updateUser(db: Db, id: Id, patch: { displayName?: string; role?: Role; disabled?: boolean; password?: string }) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!row) throw new DomainError('User not found', 404);
  const losingAdmin = row.role === 'admin' && ((patch.role && patch.role !== 'admin') || patch.disabled === true);
  if (losingAdmin) {
    const admins = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
    if (admins <= 1) throw new DomainError('There must always be at least one active Admin');
  }
  if (patch.displayName !== undefined) {
    if (!patch.displayName.trim()) throw new DomainError('Display name is required');
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(patch.displayName.trim(), id);
  }
  if (patch.role !== undefined) {
    if (patch.role !== 'staff' && patch.role !== 'admin') throw new DomainError('Role must be staff or admin');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(patch.role, id);
  }
  if (patch.disabled !== undefined) {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(patch.disabled ? 1 : 0, id);
    if (patch.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (patch.password !== undefined) {
    checkPassword(patch.password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(patch.password), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
}

function findUserByCredentials(db: Db, username: string, password: string): User {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username?.trim() ?? '') as UserRow | undefined;
  if (!row || !verifyPassword(password ?? '', row.password_hash)) throw new DomainError('Wrong username or password', 401);
  if (row.disabled) throw new DomainError('This User is disabled', 403);
  return toUser(row);
}

export interface Session {
  user: User;
  deviceId: Id | null;
}

/** Dashboard sign-in. Returns the raw token for the cookie. */
export function loginWeb(db: Db, username: string, password: string): { token: string; user: User } {
  const user = findUserByCredentials(db, username, password);
  const token = newToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run(sha256(token), user.id, nowIso(), nowIso());
  return { token, user };
}

/** Phone sign-in on a paired Device. The session stays valid until sign-out, revoke or password change. */
export function loginDevice(db: Db, deviceToken: string, username: string, password: string): { token: string; user: User } {
  const device = deviceByToken(db, deviceToken);
  if (!device) throw new DomainError('This phone is not paired, or was revoked. Scan a new pairing code.', 401);
  const user = findUserByCredentials(db, username, password);
  const token = newToken();
  db.prepare('INSERT INTO sessions (token_hash, user_id, device_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token),
    user.id,
    device.id,
    nowIso(),
    nowIso(),
  );
  db.prepare('UPDATE devices SET last_user_id = ? WHERE id = ?').run(user.id, device.id);
  return { token, user };
}

export function sessionFor(db: Db, token: string | undefined): Session | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.device_id, d.revoked_at, u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN devices d ON d.id = s.device_id
       WHERE s.token_hash = ?`,
    )
    .get(sha256(token)) as (UserRow & { device_id: string | null; revoked_at: string | null }) | undefined;
  if (!row || row.disabled || row.revoked_at) return null;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(nowIso(), sha256(token));
  return { user: toUser(row), deviceId: row.device_id };
}

export function logout(db: Db, token: string) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// ---------- Devices & pairing ----------

export function createPairingCode(db: Db, adminId: Id): { code: string; expiresAt: string } {
  // Short and unambiguous so it can also be typed by hand.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();
  db.prepare('INSERT INTO pairing_codes (code, created_by, expires_at) VALUES (?, ?, ?)').run(code, adminId, expiresAt);
  return { code, expiresAt };
}

export function pairDevice(db: Db, code: string, name: string): { deviceId: Id; deviceToken: string } {
  const row = db.prepare('SELECT * FROM pairing_codes WHERE code = ?').get(code?.trim().toUpperCase() ?? '') as
    | { code: string; expires_at: string; used_at: string | null }
    | undefined;
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) {
    throw new DomainError('This pairing code is invalid or has expired. Ask an Admin for a new one.', 401);
  }
  const deviceId = randomUUID();
  const deviceToken = newToken();
  db.prepare('UPDATE pairing_codes SET used_at = ? WHERE code = ?').run(nowIso(), row.code);
  db.prepare('INSERT INTO devices (id, name, token_hash, paired_at) VALUES (?, ?, ?, ?)').run(
    deviceId,
    name?.trim() || 'Phone',
    sha256(deviceToken),
    nowIso(),
  );
  return { deviceId, deviceToken };
}

function deviceByToken(db: Db, token: string): { id: string } | null {
  const row = db.prepare('SELECT id, revoked_at FROM devices WHERE token_hash = ?').get(sha256(token ?? '')) as
    | { id: string; revoked_at: string | null }
    | undefined;
  return row && !row.revoked_at ? { id: row.id } : null;
}

export interface DeviceInfo {
  id: Id;
  name: string;
  pairedAt: string;
  lastSyncAt: string | null;
  lastUserName: string | null;
  revokedAt: string | null;
}

export function listDevices(db: Db): DeviceInfo[] {
  const rows = db
    .prepare(
      `SELECT d.*, u.display_name AS last_user_name FROM devices d
       LEFT JOIN users u ON u.id = d.last_user_id ORDER BY d.revoked_at IS NOT NULL, d.name`,
    )
    .all() as {
    id: string;
    name: string;
    paired_at: string;
    last_sync_at: string | null;
    last_user_name: string | null;
    revoked_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    pairedAt: r.paired_at,
    lastSyncAt: r.last_sync_at,
    lastUserName: r.last_user_name,
    revokedAt: r.revoked_at,
  }));
}

export function revokeDevice(db: Db, id: Id) {
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), id);
  db.prepare('DELETE FROM sessions WHERE device_id = ?').run(id);
}

export function renameDevice(db: Db, id: Id, name: string) {
  if (!name?.trim()) throw new DomainError('Device name is required');
  db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name.trim(), id);
}

export function markDeviceSynced(db: Db, id: Id) {
  db.prepare('UPDATE devices SET last_sync_at = ? WHERE id = ?').run(nowIso(), id);
}
