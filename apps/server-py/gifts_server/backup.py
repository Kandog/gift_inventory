"""Nightly backups to the folder set on the Settings page (usually a network share)."""
from __future__ import annotations

import os
import shutil
import threading
import time
from datetime import datetime, timedelta

from .db import Db, get_setting, set_setting
from .util import now_iso, now_ms, parse_time_ms

KEEP_BACKUPS = 30
PREFIX = 'gift-inventory-'
BACKUP_HOUR = 2  # 02:00 local time


def run_backup(db: Db, photos_dir: str) -> dict:
    """Writes a consistent snapshot (VACUUM INTO) plus Gift photos into <backup.path>/gift-inventory-<stamp>/,
    then deletes all but the newest KEEP_BACKUPS copies."""
    target = get_setting(db, 'backup.path')
    try:
        if not target:
            raise RuntimeError('No backup folder is set. Set one on the Settings page.')
        if not os.path.exists(target):
            raise RuntimeError(f'Backup folder {target} cannot be reached')
        folder = os.path.join(target, PREFIX + datetime.now().strftime('%Y-%m-%d_%H%M'))
        os.makedirs(folder, exist_ok=True)
        db_file = os.path.join(folder, 'gifts.db')
        if os.path.exists(db_file):
            os.remove(db_file)
        db.run('VACUUM INTO ?', db_file)
        if os.path.exists(photos_dir):
            shutil.copytree(photos_dir, os.path.join(folder, 'photos'), dirs_exist_ok=True)
        _prune(target)
        set_setting(db, 'backup.lastSuccessAt', now_iso())
        set_setting(db, 'backup.lastFolder', folder)
        set_setting(db, 'backup.lastError', '')
        return {'folder': folder}
    except Exception as err:
        set_setting(db, 'backup.lastError', f'{now_iso()}: {err}')
        raise


def _prune(target: str):
    names = [n for n in os.listdir(target) if n.startswith(PREFIX)]
    dated = sorted(names, key=lambda n: os.stat(os.path.join(target, n)).st_mtime, reverse=True)
    for old in dated[KEEP_BACKUPS:]:
        path = os.path.join(target, old)
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        else:
            try:
                os.remove(path)
            except OSError:
                pass


def schedule_backups(db: Db, photos_dir: str, lock: threading.RLock, log):
    """Runs nightly at 02:00, and at start-up if the last good backup is over a day old."""

    def attempt():
        try:
            with lock:
                r = run_backup(db, photos_dir)
            log(f"Backup written to {r['folder']}")
        except Exception as err:  # noqa: BLE001
            log(f'Backup failed: {err}')

    def loop():
        with lock:
            last = get_setting(db, 'backup.lastSuccessAt')
            has_path = bool(get_setting(db, 'backup.path'))
        if has_path and (not last or now_ms() - (parse_time_ms(last) or 0) > 24 * 3_600_000):
            attempt()
        while True:
            now = datetime.now()
            nxt = now.replace(hour=BACKUP_HOUR, minute=0, second=0, microsecond=0)
            if nxt <= now:
                nxt += timedelta(days=1)
            # Sleep in short steps so a PC waking from sleep doesn't overshoot by hours.
            while datetime.now() < nxt:
                time.sleep(min(60, max(1, (nxt - datetime.now()).total_seconds())))
            attempt()

    threading.Thread(target=loop, name='backups', daemon=True).start()
