"""SQLite storage. Same schema and file (data/gifts.db) as the original Node server, so existing data keeps working."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager

MIGRATIONS = [
    """
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
  """,
]


class Db:
    """One SQLite connection. Callers serialize access with the server's lock, like Node's single thread did."""

    def __init__(self, path: str):
        # isolation_level=None: we issue BEGIN/COMMIT ourselves (see tx()).
        self.conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA journal_mode = WAL')
        self.conn.execute('PRAGMA foreign_keys = ON')
        self.conn.execute('PRAGMA busy_timeout = 5000')
        self._depth = 0
        self.stock_cache = None
        self._migrate()

    def _migrate(self):
        version = self.one('PRAGMA user_version')[0]
        for v in range(version, len(MIGRATIONS)):
            with self.tx():
                for stmt in MIGRATIONS[v].split(';'):
                    if stmt.strip():
                        self.conn.execute(stmt)
                self.conn.execute(f'PRAGMA user_version = {v + 1}')

    def run(self, sql: str, *params):
        return self.conn.execute(sql, params)

    def one(self, sql: str, *params):
        return self.conn.execute(sql, params).fetchone()

    def all(self, sql: str, *params):
        return self.conn.execute(sql, params).fetchall()

    @contextmanager
    def tx(self):
        """A transaction. Nested calls become savepoints, so helpers can be composed."""
        depth = self._depth
        name = f'sp{depth}'
        self.conn.execute('BEGIN IMMEDIATE' if depth == 0 else f'SAVEPOINT {name}')
        self._depth = depth + 1
        try:
            yield
        except BaseException:
            if depth == 0:
                self.conn.execute('ROLLBACK')
            else:
                self.conn.execute(f'ROLLBACK TO {name}')
                self.conn.execute(f'RELEASE {name}')
            raise
        else:
            self.conn.execute('COMMIT' if depth == 0 else f'RELEASE {name}')
        finally:
            self._depth = depth

    def close(self):
        self.conn.close()


def get_setting(db: Db, key: str) -> str | None:
    row = db.one('SELECT value FROM settings WHERE key = ?', key)
    return row['value'] if row else None


def set_setting(db: Db, key: str, value: str):
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
