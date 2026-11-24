import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('staff','admin')),
    password_hash TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    paired_at TEXT NOT NULL,
    last_sync_at TEXT,
    last_user_id TEXT REFERENCES users(id),
    revoked_at TEXT
  );
  CREATE TABLE pairing_codes (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT REFERENCES devices(id),
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE gifts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category_id TEXT REFERENCES categories(id),
    unit_cost REAL,
    low_stock_threshold INTEGER,
    photo_file TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE gift_packs (
    gift_id TEXT NOT NULL REFERENCES gifts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    pieces INTEGER NOT NULL CHECK (pieces > 1),
    PRIMARY KEY (gift_id, name)
  );
  CREATE TABLE gift_barcodes (
    code TEXT PRIMARY KEY,
    gift_id TEXT NOT NULL REFERENCES gifts(id) ON DELETE CASCADE
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    closed_at TEXT,
    auto_close_at TEXT,
    merged_into_id TEXT REFERENCES events(id),
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    gift_id TEXT NOT NULL REFERENCES gifts(id),
    location_id TEXT NOT NULL REFERENCES locations(id),
    to_location_id TEXT REFERENCES locations(id),
    quantity INTEGER NOT NULL,
    event_id TEXT REFERENCES events(id),
    note TEXT,
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT REFERENCES devices(id),
    occurred_at TEXT NOT NULL,
    occurred_ms INTEGER NOT NULL,
    synced_at TEXT NOT NULL
  );
  CREATE INDEX entries_by_time ON entries (occurred_ms, id);
  CREATE INDEX entries_by_event ON entries (event_id);
  CREATE TABLE voids (
    id TEXT PRIMARY KEY,
    entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    device_id TEXT REFERENCES devices(id),
    reason TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    synced_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

const txDepth = new WeakMap<Db, number>();

/** Runs fn in a transaction. Nested calls become savepoints, so helpers can be composed. */
export function tx<T>(db: Db, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const name = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
