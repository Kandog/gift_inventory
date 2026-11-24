import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import type { DeviceInfo } from '../reportTypes';
import { ErrorText, fmtAgo, fmtTime, Loading, Modal, PageHeader, useAction, useApi } from '../ui';

interface Pairing {
  code: string;
  expiresAt: string;
  servers: string[];
  qr: string;
}

export function DevicesPage() {
  const { data, error, reload } = useApi<DeviceInfo[]>('/api/devices');
  const [pairing, setPairing] = useState(false);
  const { error: actError, run } = useAction();
  if (!data) return <Loading error={error} />;

  const revoke = async (d: DeviceInfo) => {
    if (!confirm(`Revoke “${d.name}”? It is signed out at once and must be paired again. Entries it has not synced yet will be lost.`)) return;
    if (await run(() => api.post(`/api/devices/${d.id}/revoke`))) void reload();
  };
  const rename = async (d: DeviceInfo) => {
    const name = prompt('Device name', d.name);
    if (name && (await run(() => api.put(`/api/devices/${d.id}`, { name })))) void reload();
  };

  return (
    <>
      <PageHeader title="Devices">
        <button className="primary" onClick={() => setPairing(true)}>
          + Pair a phone
        </button>
      </PageHeader>
      <ErrorText error={actError} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>Last User</th>
              <th>Last sync</th>
              <th>Paired</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{d.lastUserName ?? '—'}</td>
                <td title={fmtTime(d.lastSyncAt)}>{fmtAgo(d.lastSyncAt)}</td>
                <td>{fmtTime(d.pairedAt)}</td>
                <td>{d.revokedAt ? <span className="badge bad">Revoked</span> : <span className="badge ok">Active</span>}</td>
                <td className="actions">
                  {!d.revokedAt && (
                    <>
                      <button className="small" onClick={() => rename(d)}>
                        Rename
                      </button>
                      <button className="small danger" onClick={() => revoke(d)}>
                        Revoke
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {data.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No phones paired yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pairing && (
        <PairModal
          onClose={() => {
            setPairing(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

function PairModal({ onClose }: { onClose: () => void }) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const { error, run } = useAction();

  useEffect(() => {
    void run(async () => {
      const p = await api.post<Pairing>('/api/pairing');
      setPairing(p);
      setImg(await QRCode.toDataURL(p.qr, { width: 520, margin: 1 }));
    });
  }, [run]);

  return (
    <Modal title="Pair a phone" onClose={onClose}>
      {pairing && img ? (
        <>
          <ol style={{ paddingLeft: 18 }}>
            <li>Connect the phone to the office Wi-Fi.</li>
            <li>
              Open the Gift Inventory app and tap <strong>Scan pairing code</strong>.
            </li>
            <li>Scan this code, then sign in with your username and password.</li>
          </ol>
          <img className="qr" src={img} alt="Pairing QR code" />
          <p className="muted">
            Can't scan? Enter server <code>{pairing.servers[0] ?? '(no network address found)'}</code> and code <code>{pairing.code}</code>.
            <br />
            Works once and expires {fmtTime(pairing.expiresAt)}.
          </p>
          {pairing.servers.length === 0 && <p className="error">This PC has no network address. Check that it is connected to the Wi-Fi or network.</p>}
        </>
      ) : (
        <Loading error={error} />
      )}
      <footer>
        <button onClick={onClose}>Done</button>
      </footer>
    </Modal>
  );
}
