import { createContext, useContext, useEffect, useState, type FormEvent } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { User } from '@gifts/shared';
import { api } from './api';
import { ErrorText, Field, useAction } from './ui';
import { HomePage } from './pages/Home';
import { StockPage } from './pages/Stock';
import { GiftsPage } from './pages/Gifts';
import { EventsPage, EventReportPage } from './pages/Events';
import { ActivityPage } from './pages/Activity';
import { LocationsPage } from './pages/Locations';
import { UsersPage } from './pages/Users';
import { DevicesPage } from './pages/Devices';
import { SettingsPage } from './pages/Settings';

const MeContext = createContext<User | null>(null);
export const useMe = () => useContext(MeContext)!;

type State = { kind: 'loading' } | { kind: 'setup' } | { kind: 'signed-out' } | { kind: 'signed-in'; user: User };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const refresh = async () => {
    const { needsSetup } = await api.get<{ needsSetup: boolean }>('/api/setup/status');
    if (needsSetup) return setState({ kind: 'setup' });
    try {
      const { user } = await api.get<{ user: User }>('/api/auth/me');
      setState({ kind: 'signed-in', user });
    } catch {
      setState({ kind: 'signed-out' });
    }
  };

  useEffect(() => {
    void refresh();
    const onOut = () => setState({ kind: 'signed-out' });
    window.addEventListener('gifts:signed-out', onOut);
    return () => window.removeEventListener('gifts:signed-out', onOut);
  }, []);

  if (state.kind === 'loading') return null;
  if (state.kind === 'setup') return <SetupScreen onDone={refresh} />;
  if (state.kind === 'signed-out') return <LoginScreen onDone={refresh} />;
  if (state.user.role !== 'admin') {
    return (
      <div className="auth">
        <div className="panel">
          <h2>Admins only</h2>
          <p>The dashboard is for Admins. Staff record stock in the phone app.</p>
          <button onClick={() => api.post('/api/auth/logout').then(refresh)}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <MeContext.Provider value={state.user}>
      <div className="layout">
        <nav className="sidebar">
          <div className="brand">🎁 Gift Inventory</div>
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/stock">Stock</NavLink>
          <NavLink to="/events">Events</NavLink>
          <NavLink to="/activity">Activity</NavLink>
          <div className="section">Manage</div>
          <NavLink to="/gifts">Gifts & labels</NavLink>
          <NavLink to="/locations">Locations & categories</NavLink>
          <NavLink to="/users">Users</NavLink>
          <NavLink to="/devices">Devices</NavLink>
          <NavLink to="/settings">Settings & backup</NavLink>
          <div className="me">
            Signed in as <strong>{state.user.displayName}</strong>
            <br />
            <button className="small" onClick={() => api.post('/api/auth/logout').then(refresh)}>
              Sign out
            </button>
          </div>
        </nav>
        <main>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/stock" element={<StockPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/events/:id" element={<EventReportPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/gifts" element={<GiftsPage />} />
            <Route path="/locations" element={<LocationsPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </MeContext.Provider>
  );
}

function LoginScreen({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.post('/api/auth/login', { username, password }))) onDone();
  };
  return (
    <div className="auth">
      <form className="panel" onSubmit={submit}>
        <h2>🎁 Gift Inventory: sign in</h2>
        <Field label="Username">
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </Field>
        <Field label="Password">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <ErrorText error={error} />
        <button className="primary" disabled={busy}>
          Sign in
        </button>
      </form>
    </div>
  );
}

function SetupScreen({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ username: '', displayName: '', password: '', confirm: '' });
  const { busy, error, run, setError } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setError('The passwords do not match');
    if (await run(() => api.post('/api/setup', form))) onDone();
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <div className="auth">
      <form className="panel" onSubmit={submit}>
        <h2>Welcome! Create the first Admin</h2>
        <p className="muted">This only happens once. You can add more Users afterwards.</p>
        <Field label="Your name">
          <input autoFocus value={form.displayName} onChange={set('displayName')} />
        </Field>
        <Field label="Username">
          <input value={form.username} onChange={set('username')} autoComplete="username" />
        </Field>
        <Field label="Password" hint="At least 8 characters">
          <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
        <Field label="Confirm password">
          <input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" />
        </Field>
        <ErrorText error={error} />
        <button className="primary" disabled={busy}>
          Create Admin
        </button>
      </form>
    </div>
  );
}
