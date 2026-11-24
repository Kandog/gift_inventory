import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { KEEP_BACKUPS, runBackup } from './backup.js';
import { getSetting, openDb, setSetting, type Db } from './db.js';
import { createLocation } from './store.js';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gifts-backup-'));
  db = openDb(join(dir, 'gifts.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it('writes a readable copy of the database and the photos', async () => {
  createLocation(db, 'Van');
  const photos = join(dir, 'photos');
  mkdirSync(photos);
  writeFileSync(join(photos, 'a.jpg'), 'x');
  const target = join(dir, 'share');
  mkdirSync(target);
  setSetting(db, 'backup.path', target);

  const { folder } = await runBackup(db, photos);
  const copy = new DatabaseSync(join(folder, 'gifts.db'));
  expect(copy.prepare("SELECT name FROM locations WHERE name = 'Van'").get()).toBeTruthy();
  copy.close();
  expect(existsSync(join(folder, 'photos', 'a.jpg'))).toBe(true);
  expect(getSetting(db, 'backup.lastSuccessAt')).toBeTruthy();
});

it(`keeps only the newest ${KEEP_BACKUPS} backups`, async () => {
  const target = join(dir, 'share');
  mkdirSync(target);
  for (let i = 0; i < KEEP_BACKUPS + 3; i++) {
    const old = join(target, `gift-inventory-2020-01-${String(i + 1).padStart(2, '0')}_0200`);
    mkdirSync(old);
    const t = new Date(2020, 0, i + 1);
    utimesSync(old, t, t);
  }
  setSetting(db, 'backup.path', target);
  await runBackup(db, join(dir, 'photos'));
  const left = readdirSync(target).sort();
  expect(left).toHaveLength(KEEP_BACKUPS);
  expect(left[0]).toBe('gift-inventory-2020-01-05_0200'); // the 4 oldest were removed
});

it('records an error when the share cannot be reached', async () => {
  setSetting(db, 'backup.path', join(dir, 'no-such-share'));
  await expect(runBackup(db, join(dir, 'photos'))).rejects.toThrow(/cannot be reached/);
  expect(getSetting(db, 'backup.lastError')).toMatch(/cannot be reached/);
});
