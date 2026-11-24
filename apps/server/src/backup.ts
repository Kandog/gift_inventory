import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSetting, setSetting, type Db } from './db.js';

export const KEEP_BACKUPS = 30;
const PREFIX = 'gift-inventory-';
const BACKUP_HOUR = 2; // 02:00 local time

const stamp = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Writes a consistent snapshot (VACUUM INTO) plus Gift photos into <backup.path>/gift-inventory-<stamp>/,
 * then deletes all but the newest KEEP_BACKUPS copies.
 */
export async function runBackup(db: Db, photosDir: string): Promise<{ folder: string }> {
  const target = getSetting(db, 'backup.path');
  try {
    if (!target) throw new Error('No backup folder is set. Set one on the Settings page.');
    if (!existsSync(target)) throw new Error(`Backup folder ${target} cannot be reached`);
    const folder = join(target, PREFIX + stamp(new Date()));
    await mkdir(folder, { recursive: true });
    const dbFile = join(folder, 'gifts.db');
    if (existsSync(dbFile)) await rm(dbFile);
    db.prepare('VACUUM INTO ?').run(dbFile);
    if (existsSync(photosDir)) await cp(photosDir, join(folder, 'photos'), { recursive: true });
    await prune(target);
    setSetting(db, 'backup.lastSuccessAt', new Date().toISOString());
    setSetting(db, 'backup.lastFolder', folder);
    setSetting(db, 'backup.lastError', '');
    return { folder };
  } catch (err) {
    setSetting(db, 'backup.lastError', `${new Date().toISOString()}: ${(err as Error).message}`);
    throw err;
  }
}

async function prune(target: string) {
  const names = (await readdir(target)).filter((n) => n.startsWith(PREFIX));
  const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(target, n))).mtimeMs })));
  dated.sort((a, b) => b.t - a.t);
  for (const old of dated.slice(KEEP_BACKUPS)) await rm(join(target, old.n), { recursive: true, force: true });
}

/** Runs nightly at 02:00, and at start-up if the last good backup is over a day old. */
export function scheduleBackups(db: Db, photosDir: string, log: (msg: string) => void) {
  const attempt = () =>
    runBackup(db, photosDir).then(
      (r) => log(`Backup written to ${r.folder}`),
      (e) => log(`Backup failed: ${(e as Error).message}`),
    );

  const last = getSetting(db, 'backup.lastSuccessAt');
  if (getSetting(db, 'backup.path') && (!last || Date.now() - Date.parse(last) > 24 * 3_600_000)) void attempt();

  const scheduleNext = () => {
    const next = new Date();
    next.setHours(BACKUP_HOUR, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    const timer = setTimeout(async () => {
      await attempt();
      scheduleNext();
    }, next.getTime() - Date.now());
    timer.unref();
  };
  scheduleNext();
}
