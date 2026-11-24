import { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorText, Field, fmtAgo, fmtTime, Loading, PageHeader, useAction, useApi } from '../ui';

interface Settings {
  backupPath: string;
  lastBackupAt: string | null;
  lastBackupFolder: string | null;
  lastBackupError: string | null;
  dataDir: string;
  addresses: string[];
}

export function SettingsPage() {
  const { data, error, reload } = useApi<Settings>('/api/settings');
  const [path, setPath] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const save = useAction();
  const backup = useAction();
  useEffect(() => setPath(data?.backupPath ?? ''), [data?.backupPath]);
  if (!data) return <Loading error={error} />;

  return (
    <>
      <PageHeader title="Settings & backup" />
      <div className="grid-2">
        <section className="panel">
          <h2>Backup</h2>
          <p className="muted">
            Every night at 02:00 the server copies the database and Gift photos into the folder below and keeps the newest 30 copies.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await save.run(() => api.put('/api/settings', { backupPath: path }))) {
                setMessage('Saved.');
                void reload();
              }
            }}
          >
            <Field label="Backup folder" hint="A network shared folder, e.g. \\NAS\Backups\Gifts. The Windows service account needs write access to it.">
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="\\SERVER\Share\GiftBackups" />
            </Field>
            <div className="actions">
              <button className="primary" disabled={save.busy}>
                Save
              </button>
              <button
                type="button"
                disabled={backup.busy || !data.backupPath}
                onClick={async () => {
                  setMessage(null);
                  const ok = await backup.run(async () => {
                    const r = await api.post<{ folder: string }>('/api/backup/run');
                    setMessage(`Backup written to ${r.folder}`);
                  });
                  if (ok || !ok) void reload();
                }}
              >
                {backup.busy ? 'Backing up…' : 'Back up now'}
              </button>
            </div>
          </form>
          <ErrorText error={save.error ?? backup.error} />
          {message && <p>{message}</p>}
          <ul className="plain" style={{ marginTop: 12 }}>
            <li>
              <span>Last good backup</span>
              <span title={fmtTime(data.lastBackupAt)}>{fmtAgo(data.lastBackupAt)}</span>
            </li>
            {data.lastBackupFolder && (
              <li>
                <span>Last folder</span>
                <code>{data.lastBackupFolder}</code>
              </li>
            )}
            {data.lastBackupError && (
              <li>
                <span>Last error</span>
                <span className="error">{data.lastBackupError}</span>
              </li>
            )}
          </ul>
          <h3>Restoring</h3>
          <ol className="muted" style={{ paddingLeft: 18 }}>
            <li>Stop the Gift Inventory service.</li>
            <li>
              Copy <code>gifts.db</code> and the <code>photos</code> folder from a backup into <code>{data.dataDir}</code>, replacing the files there and deleting any <code>gifts.db-wal</code> / <code>gifts.db-shm</code>.
            </li>
            <li>Start the service. Phones then re-send anything they recorded after that backup on their next sync.</li>
          </ol>
        </section>
        <section className="panel">
          <h2>Server</h2>
          <ul className="plain">
            <li>
              <span>Data folder</span>
              <code>{data.dataDir}</code>
            </li>
            {data.addresses.map((a) => (
              <li key={a}>
                <span>Network address</span>
                <code>{a}</code>
              </li>
            ))}
          </ul>
          <p className="muted">
            Tip: give this PC a fixed IP address in your router (a “DHCP reservation”) so phones always find it at the same address.
          </p>
        </section>
      </div>
    </>
  );
}
