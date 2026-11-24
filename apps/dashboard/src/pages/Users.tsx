import { useState, type FormEvent } from 'react';
import type { Role, User } from '@gifts/shared';
import { api } from '../api';
import { useMe } from '../App';
import { ErrorText, Field, Loading, Modal, PageHeader, useAction, useApi } from '../ui';

export function UsersPage() {
  const me = useMe();
  const { data, error, reload } = useApi<User[]>('/api/users');
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <PageHeader title="Users">
        <button className="primary" onClick={() => setEditing('new')}>
          + New User
        </button>
      </PageHeader>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Role</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.displayName} {u.id === me.id && <span className="muted">(you)</span>}
                </td>
                <td>{u.username}</td>
                <td>{u.role === 'admin' ? <span className="badge info">Admin</span> : <span className="badge">Staff</span>}</td>
                <td>{u.disabled ? <span className="badge bad">Disabled</span> : <span className="badge ok">Active</span>}</td>
                <td>
                  <button className="small" onClick={() => setEditing(u)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <UserModal
          user={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

function UserModal({ user, onClose, onSaved }: { user: User | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    displayName: user?.displayName ?? '',
    username: user?.username ?? '',
    role: (user?.role ?? 'staff') as Role,
    disabled: user?.disabled ?? false,
    password: '',
  });
  const { busy, error, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() =>
      user
        ? api.put(`/api/users/${user.id}`, {
            displayName: form.displayName,
            role: form.role,
            disabled: form.disabled,
            ...(form.password ? { password: form.password } : {}),
          })
        : api.post('/api/users', form),
    );
    if (ok) onSaved();
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal title={user ? `Edit ${user.displayName}` : 'New User'} onClose={onClose}>
      <form onSubmit={save}>
        <Field label="Name">
          <input autoFocus required value={form.displayName} onChange={set('displayName')} />
        </Field>
        <Field label="Username" hint={user ? 'Usernames cannot be changed' : 'Used to sign in on the phone and dashboard'}>
          <input required disabled={!!user} value={form.username} onChange={set('username')} autoComplete="off" />
        </Field>
        <Field label="Role">
          <select value={form.role} onChange={set('role')}>
            <option value="staff">Staff: records Counts and Movements on the phone</option>
            <option value="admin">Admin: also manages everything here</option>
          </select>
        </Field>
        <Field label={user ? 'New password (leave blank to keep)' : 'Password'} hint="At least 8 characters. Changing it signs the User out everywhere.">
          <input type="password" required={!user} value={form.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
        {user && (
          <label className="row" style={{ alignItems: 'center' }}>
            <input type="checkbox" checked={form.disabled} onChange={(e) => setForm({ ...form, disabled: e.target.checked })} style={{ flex: 0 }} />
            <span>Disabled: cannot sign in; past entries are kept</span>
          </label>
        )}
        <ErrorText error={error} />
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            Save
          </button>
        </footer>
      </form>
    </Modal>
  );
}
