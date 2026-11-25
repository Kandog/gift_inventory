"""Users, sign-in sessions, phone pairing and Devices.

Password hashes use the same scrypt format as the original Node server (N=16384, r=8, p=1, 32 bytes),
so existing Users keep their passwords.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets

from .db import Db
from .util import DomainError, ms_to_iso, new_id, now_iso, now_ms, parse_time_ms, text

PAIRING_CODE_TTL_MS = 10 * 60 * 1000
_SCRYPT = dict(n=16384, r=8, p=1, maxmem=64 * 1024 * 1024)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    return f'scrypt${salt.hex()}${h.hex()}'


def verify_password(password: str, stored: str) -> bool:
    parts = stored.split('$')
    if len(parts) != 3 or parts[0] != 'scrypt' or not parts[1] or not parts[2]:
        return False
    expected = bytes.fromhex(parts[2])
    actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(parts[1]), dklen=len(expected), **_SCRYPT)
    return hmac.compare_digest(expected, actual)


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def new_token() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b'=').decode()


def _to_user(r) -> dict:
    return {
        'id': r['id'],
        'username': r['username'],
        'displayName': r['display_name'],
        'role': r['role'],
        'disabled': bool(r['disabled']),
    }


def count_users(db: Db) -> int:
    return db.one('SELECT COUNT(*) AS n FROM users')['n']


def list_users(db: Db) -> list[dict]:
    return [_to_user(r) for r in db.all('SELECT * FROM users ORDER BY display_name')]


def _check_password(password):
    if not isinstance(password, str) or len(password) < 8:
        raise DomainError('Password must be at least 8 characters')


_USERNAME_RE = re.compile(r'^[A-Za-z0-9._-]{2,40}$')


def create_user(db: Db, inp: dict) -> dict:
    inp = inp if isinstance(inp, dict) else {}
    username = text(inp.get('username')).strip()
    if not username or not _USERNAME_RE.match(username):
        raise DomainError('Username must be 2–40 letters, digits, dots, dashes or underscores')
    if not text(inp.get('displayName')).strip():
        raise DomainError('Display name is required')
    if inp.get('role') not in ('staff', 'admin'):
        raise DomainError('Role must be staff or admin')
    _check_password(inp.get('password'))
    if db.one('SELECT 1 FROM users WHERE username = ?', username):
        raise DomainError('That username is taken')
    uid = new_id()
    db.run(
        'INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        uid,
        username,
        inp['displayName'].strip(),
        inp['role'],
        hash_password(inp['password']),
        now_iso(),
    )
    return _to_user(db.one('SELECT * FROM users WHERE id = ?', uid))


def update_user(db: Db, uid: str, patch: dict):
    patch = patch if isinstance(patch, dict) else {}
    row = db.one('SELECT * FROM users WHERE id = ?', uid)
    if not row:
        raise DomainError('User not found', 404)
    role = patch.get('role')
    disabled = patch.get('disabled')
    losing_admin = row['role'] == 'admin' and ((role and role != 'admin') or disabled is True)
    if losing_admin:
        admins = db.one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")['n']
        if admins <= 1:
            raise DomainError('There must always be at least one active Admin')
    if patch.get('displayName') is not None:
        name = text(patch['displayName']).strip()
        if not name:
            raise DomainError('Display name is required')
        db.run('UPDATE users SET display_name = ? WHERE id = ?', name, uid)
    if role is not None:
        if role not in ('staff', 'admin'):
            raise DomainError('Role must be staff or admin')
        db.run('UPDATE users SET role = ? WHERE id = ?', role, uid)
    if disabled is not None:
        db.run('UPDATE users SET disabled = ? WHERE id = ?', 1 if disabled else 0, uid)
        if disabled:
            db.run('DELETE FROM sessions WHERE user_id = ?', uid)
    if patch.get('password') is not None:
        _check_password(patch['password'])
        db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash_password(patch['password']), uid)
        db.run('DELETE FROM sessions WHERE user_id = ?', uid)


def _find_user_by_credentials(db: Db, username, password) -> dict:
    row = db.one('SELECT * FROM users WHERE username = ?', text(username).strip())
    if not row or not verify_password(text(password), row['password_hash']):
        raise DomainError('Wrong username or password', 401)
    if row['disabled']:
        raise DomainError('This User is disabled', 403)
    return _to_user(row)


def login_web(db: Db, username, password) -> tuple[str, dict]:
    """Dashboard sign-in. Returns the raw token for the cookie."""
    user = _find_user_by_credentials(db, username, password)
    token = new_token()
    db.run('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)', sha256(token), user['id'], now_iso(), now_iso())
    return token, user


def login_device(db: Db, device_token, username, password) -> dict:
    """Phone sign-in on a paired Device. The session stays valid until sign-out, revoke or password change."""
    device = _device_by_token(db, text(device_token))
    if not device:
        raise DomainError('This phone is not paired, or was revoked. Scan a new pairing code.', 401)
    user = _find_user_by_credentials(db, username, password)
    token = new_token()
    db.run(
        'INSERT INTO sessions (token_hash, user_id, device_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        sha256(token),
        user['id'],
        device,
        now_iso(),
        now_iso(),
    )
    db.run('UPDATE devices SET last_user_id = ? WHERE id = ?', user['id'], device)
    return {'token': token, 'user': user}


def session_for(db: Db, token: str | None) -> dict | None:
    """{'user': ..., 'deviceId': ...} for a valid token, else None."""
    if not token:
        return None
    row = db.one(
        """SELECT s.device_id AS s_device_id, d.revoked_at AS d_revoked_at, u.* FROM sessions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN devices d ON d.id = s.device_id
           WHERE s.token_hash = ?""",
        sha256(token),
    )
    if not row or row['disabled'] or row['d_revoked_at']:
        return None
    db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now_iso(), sha256(token))
    return {'user': _to_user(row), 'deviceId': row['s_device_id']}


def logout(db: Db, token: str):
    db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token))


# ---------- Devices & pairing ----------

_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'  # short and unambiguous so it can also be typed by hand


def create_pairing_code(db: Db, admin_id: str) -> dict:
    code = ''.join(_ALPHABET[b % len(_ALPHABET)] for b in secrets.token_bytes(8))
    expires_at = ms_to_iso(now_ms() + PAIRING_CODE_TTL_MS)
    db.run('INSERT INTO pairing_codes (code, created_by, expires_at) VALUES (?, ?, ?)', code, admin_id, expires_at)
    return {'code': code, 'expiresAt': expires_at}


def pair_device(db: Db, code, name) -> dict:
    row = db.one('SELECT * FROM pairing_codes WHERE code = ?', text(code).strip().upper())
    if not row or row['used_at'] or (parse_time_ms(row['expires_at']) or 0) < now_ms():
        raise DomainError('This pairing code is invalid or has expired. Ask an Admin for a new one.', 401)
    device_id = new_id()
    device_token = new_token()
    db.run('UPDATE pairing_codes SET used_at = ? WHERE code = ?', now_iso(), row['code'])
    db.run(
        'INSERT INTO devices (id, name, token_hash, paired_at) VALUES (?, ?, ?, ?)',
        device_id,
        text(name).strip() or 'Phone',
        sha256(device_token),
        now_iso(),
    )
    return {'deviceId': device_id, 'deviceToken': device_token}


def _device_by_token(db: Db, token: str) -> str | None:
    row = db.one('SELECT id, revoked_at FROM devices WHERE token_hash = ?', sha256(token))
    return row['id'] if row and not row['revoked_at'] else None


def list_devices(db: Db) -> list[dict]:
    rows = db.all(
        """SELECT d.*, u.display_name AS last_user_name FROM devices d
           LEFT JOIN users u ON u.id = d.last_user_id ORDER BY d.revoked_at IS NOT NULL, d.name"""
    )
    return [
        {
            'id': r['id'],
            'name': r['name'],
            'pairedAt': r['paired_at'],
            'lastSyncAt': r['last_sync_at'],
            'lastUserName': r['last_user_name'],
            'revokedAt': r['revoked_at'],
        }
        for r in rows
    ]


def revoke_device(db: Db, did: str):
    db.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now_iso(), did)
    db.run('DELETE FROM sessions WHERE device_id = ?', did)


def rename_device(db: Db, did: str, name):
    if not text(name).strip():
        raise DomainError('Device name is required')
    db.run('UPDATE devices SET name = ? WHERE id = ?', text(name).strip(), did)


def mark_device_synced(db: Db, did: str):
    db.run('UPDATE devices SET last_sync_at = ? WHERE id = ?', now_iso(), did)
