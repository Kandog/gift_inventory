import { useMemo, useState, type FormEvent } from 'react';
import type { EntryKind } from '@gifts/shared';
import { api, download } from '../api';
import { useLookups } from '../lookups';
import type { ActivityRow } from '../reportTypes';
import { ErrorText, Field, fmtInt, fmtTime, KIND_LABEL, Loading, Modal, PageHeader, useAction, useApi, uuid } from '../ui';

const PAGE = 50;

export function ActivityPage() {
  const [newEntry, setNewEntry] = useState(false);
  const [version, setVersion] = useState(0);
  return (
    <>
      <PageHeader title="Activity">
        <button className="primary" onClick={() => setNewEntry(true)}>
          + Record entry
        </button>
      </PageHeader>
      <ActivityTable key={version} />
      {newEntry && (
        <EntryModal
          title="Record an entry"
          onClose={() => setNewEntry(false)}
          onSaved={() => {
            setNewEntry(false);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </>
  );
}

export function ActivityTable({ limit = PAGE, compact = false, eventId }: { limit?: number; compact?: boolean; eventId?: string }) {
  const lk = useLookups();
  const [filter, setFilter] = useState({ giftId: '', locationId: '', eventId: eventId ?? '', kind: '', from: '', to: '' });
  const [page, setPage] = useState(0);
  const [correcting, setCorrecting] = useState<ActivityRow | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) p.set(k, k === 'to' ? nextDay(v) : v);
    return p;
  }, [filter]);
  const url = `/api/entries?${qs}&limit=${limit}&offset=${page * limit}`;
  const { data, error, reload } = useApi<{ rows: ActivityRow[]; total: number }>(url);

  const set = (k: keyof typeof filter) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setPage(0);
    setFilter({ ...filter, [k]: e.target.value });
  };

  return (
    <>
      {!compact && (
        <div className="filters">
          <select value={filter.kind} onChange={set('kind')}>
            <option value="">All types</option>
            {Object.entries(KIND_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <select value={filter.giftId} onChange={set('giftId')}>
            <option value="">All Gifts</option>
            {lk.gifts.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <select value={filter.locationId} onChange={set('locationId')}>
            <option value="">All Locations</option>
            {lk.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {!eventId && (
            <select value={filter.eventId} onChange={set('eventId')}>
              <option value="">All Events</option>
              {lk.events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          )}
          <input type="date" value={filter.from} onChange={set('from')} title="From" />
          <input type="date" value={filter.to} onChange={set('to')} title="To" />
          <button onClick={() => download(`/api/export/activity.xlsx?${qs}`)}>Export Excel</button>
          <button onClick={() => download(`/api/export/activity.csv?${qs}`)}>Export CSV</button>
        </div>
      )}
      {!data || !lk.ready ? (
        <Loading error={error} />
      ) : (
        <div className="table-wrap" style={compact ? { maxHeight: 'none' } : undefined}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Gift</th>
                <th>Where</th>
                <th className="num">Pieces</th>
                <th>Event / note</th>
                <th>By</th>
                {!compact && <th />}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className={r.voided ? 'voided' : ''}>
                  <td title={`Synced ${fmtTime(r.syncedAt)}`}>{fmtTime(r.occurredAt)}</td>
                  <td>
                    <KindBadge kind={r.kind} />
                  </td>
                  <td>{lk.giftName(r.giftId)}</td>
                  <td>
                    {lk.locName(r.locationId)}
                    {r.toLocationId && <> → {lk.locName(r.toLocationId)}</>}
                  </td>
                  <td className="num">{signed(r)}</td>
                  <td>
                    {r.eventId && lk.evName(r.eventId)}
                    {r.note && <span className="muted"> {r.note}</span>}
                    {r.voided && (
                      <div className="void-note muted" style={{ textDecoration: 'none' }}>
                        Voided by {r.voided.byName}: “{r.voided.reason}”
                      </div>
                    )}
                  </td>
                  <td>
                    {r.userName}
                    {r.deviceName && <div className="muted">{r.deviceName}</div>}
                  </td>
                  {!compact && (
                    <td>
                      {!r.voided && (
                        <button className="small" onClick={() => setCorrecting(r)}>
                          Void / correct
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    Nothing recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!compact && data && data.total > limit && (
        <div className="actions" style={{ marginTop: 10 }}>
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>
            ← Newer
          </button>
          <span className="muted">
            {page * limit + 1}–{Math.min((page + 1) * limit, data.total)} of {fmtInt(data.total)}
          </span>
          <button disabled={(page + 1) * limit >= data.total} onClick={() => setPage(page + 1)}>
            Older →
          </button>
        </div>
      )}
      {correcting && (
        <EntryModal
          title="Void & correct"
          correcting={correcting}
          onClose={() => setCorrecting(null)}
          onSaved={() => {
            setCorrecting(null);
            void reload();
          }}
        />
      )}
    </>
  );
}

function signed(r: ActivityRow) {
  if (r.kind === 'count') return `= ${fmtInt(r.quantity)}`;
  if (r.kind === 'receive') return `+${fmtInt(r.quantity)}`;
  if (r.kind === 'transfer') return `⇄ ${fmtInt(r.quantity)}`;
  return `−${fmtInt(r.quantity)}`;
}

export function KindBadge({ kind }: { kind: EntryKind }) {
  const cls = kind === 'receive' ? 'ok' : kind === 'issue' ? 'info' : kind === 'writeoff' ? 'bad' : kind === 'count' ? 'warn' : '';
  return <span className={`badge ${cls}`}>{KIND_LABEL[kind]}</span>;
}

const nextDay = (d: string) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, day + 1).toISOString();
};

/**
 * Records a new entry from the dashboard, or (with `correcting`) Voids an entry and optionally
 * records its replacement in one step (ADR 0003).
 */
function EntryModal({ title, correcting, onClose, onSaved }: { title: string; correcting?: ActivityRow; onClose: () => void; onSaved: () => void }) {
  const lk = useLookups();
  const [replace, setReplace] = useState(true);
  const [reason, setReason] = useState('');
  const [form, setForm] = useState({
    kind: (correcting?.kind ?? 'receive') as EntryKind,
    giftId: correcting?.giftId ?? '',
    locationId: correcting?.locationId ?? '',
    toLocationId: correcting?.toLocationId ?? '',
    eventId: correcting?.eventId ?? '',
    amount: correcting ? String(correcting.quantity) : '',
    pack: '',
    note: correcting?.note ?? '',
  });
  const { busy, error, run } = useAction();
  const gift = lk.gifts.find((g) => g.id === form.giftId);
  const packPieces = gift?.packs.find((p) => p.name === form.pack)?.pieces ?? null;
  const pieces = Number(form.amount) * (packPieces ?? 1);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const entry = () => ({
    kind: form.kind,
    giftId: form.giftId,
    locationId: form.locationId,
    toLocationId: form.kind === 'transfer' ? form.toLocationId : null,
    eventId: form.kind === 'issue' ? form.eventId : null,
    quantity: pieces,
    note: form.note || null,
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(async () => {
      if (correcting) {
        await api.post(`/api/entries/${correcting.id}/void`, { reason, replacement: replace ? entry() : null });
      } else {
        await api.post('/api/entries', { ...entry(), id: uuid(), occurredAt: new Date().toISOString() });
      }
    });
    if (ok) onSaved();
  };

  if (!lk.ready) return null;
  const showForm = !correcting || replace;

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        {correcting && (
          <>
            <p className="muted">
              The original entry stays in the history, struck through, and stops counting towards stock.
            </p>
            <Field label="Why is it wrong?">
              <input autoFocus required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Typed 300 instead of 30" />
            </Field>
            <label className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} style={{ flex: 0 }} />
              <span>Record a corrected entry in its place</span>
            </label>
          </>
        )}
        {showForm && (
          <>
            <Field label="Type">
              <select value={form.kind} onChange={set('kind')}>
                {Object.entries(KIND_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Gift">
              <select required value={form.giftId} onChange={(e) => setForm({ ...form, giftId: e.target.value, pack: '' })}>
                <option value="">Choose…</option>
                {lk.gifts
                  .filter((g) => !g.archived || g.id === form.giftId)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </select>
            </Field>
            <div className="row">
              <Field label={form.kind === 'transfer' ? 'From Location' : 'Location'}>
                <select required value={form.locationId} onChange={set('locationId')}>
                  <option value="">Choose…</option>
                  {lk.locations
                    .filter((l) => !l.archived)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </select>
              </Field>
              {form.kind === 'transfer' && (
                <Field label="To Location">
                  <select required value={form.toLocationId} onChange={set('toLocationId')}>
                    <option value="">Choose…</option>
                    {lk.locations
                      .filter((l) => !l.archived && l.id !== form.locationId)
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </select>
                </Field>
              )}
            </div>
            {form.kind === 'issue' && (
              <Field label="Event">
                <select required value={form.eventId} onChange={set('eventId')}>
                  <option value="">Choose…</option>
                  {lk.events
                    .filter((ev) => ev.open || ev.id === form.eventId)
                    .map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <div className="row">
              <Field label={form.kind === 'count' ? 'Counted' : 'Amount'}>
                <input required type="number" min={form.kind === 'count' ? 0 : 1} step={1} value={form.amount} onChange={set('amount')} />
              </Field>
              <Field label="Unit">
                <select value={form.pack} onChange={set('pack')}>
                  <option value="">Pieces</option>
                  {gift?.packs.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name} (×{p.pieces})
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {packPieces && Number.isFinite(pieces) && <p className="muted">= {fmtInt(pieces)} Pieces</p>}
            <Field label="Note (optional)">
              <input value={form.note} onChange={set('note')} />
            </Field>
          </>
        )}
        <ErrorText error={error} />
        <footer>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {correcting ? (replace ? 'Void & record correction' : 'Void entry') : 'Save'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
