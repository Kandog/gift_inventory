import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, download } from '../api';
import type { EventReport, EventSummary } from '../reportTypes';
import { ErrorText, Field, fmtInt, fmtMoney, fmtTime, Loading, Modal, PageHeader, todayIso, useAction, useApi } from '../ui';
import { ActivityTable } from './Activity';

export function EventsPage() {
  const { data, error, reload } = useApi<EventSummary[]>('/api/events');
  const [editing, setEditing] = useState<EventSummary | 'new' | null>(null);
  const [showClosed, setShowClosed] = useState(true);
  const nav = useNavigate();

  if (!data) return <Loading error={error} />;
  const rows = data.filter((e) => showClosed || e.open);

  return (
    <>
      <PageHeader title="Events">
        <label className="row" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed
        </label>
        <button onClick={() => download('/api/export/events.xlsx')}>Export Excel</button>
        <button className="primary" onClick={() => setEditing('new')}>
          + New Event
        </button>
      </PageHeader>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Dates</th>
              <th>Status</th>
              <th className="num">Pieces issued</th>
              <th className="num">Cost</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="clickable" onClick={() => nav(`/events/${e.id}`)}>
                <td>
                  <strong>{e.name}</strong>
                  {e.mergedFrom.length > 0 && <div className="muted">also: {e.mergedFrom.join(', ')}</div>}
                </td>
                <td>
                  {e.startDate} → {e.endDate}
                </td>
                <td>
                  <EventStatus open={e.open} />
                </td>
                <td className="num">{fmtInt(e.piecesIssued)}</td>
                <td className="num">{fmtMoney(e.cost)}</td>
                <td onClick={(ev) => ev.stopPropagation()}>
                  <button className="small" onClick={() => setEditing(e)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  No Events yet. Staff can also create them from the phone app.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && (
        <EventModal
          event={editing === 'new' ? null : editing}
          all={data}
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

function EventStatus({ open }: { open: boolean }) {
  return open ? <span className="badge ok">Open</span> : <span className="badge">Closed</span>;
}

function EventModal({ event, all, onClose, onSaved }: { event: EventSummary | null; all: EventSummary[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: event?.name ?? '', startDate: event?.startDate ?? todayIso(), endDate: event?.endDate ?? todayIso() });
  const [mergeInto, setMergeInto] = useState('');
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => (event ? api.put(`/api/events/${event.id}`, form) : api.post('/api/events', form)))) onSaved();
  };
  const act = async (fn: () => Promise<unknown>) => (await run(fn)) && onSaved();

  return (
    <Modal title={event ? `Edit “${event.name}”` : 'New Event'} onClose={onClose}>
      <form onSubmit={save}>
        <Field label="Name">
          <input autoFocus required value={form.name} onChange={set('name')} placeholder="e.g. Fall Career Fair 2026" />
        </Field>
        <div className="row">
          <Field label="Starts">
            <input type="date" required value={form.startDate} onChange={set('startDate')} />
          </Field>
          <Field label="Ends">
            <input type="date" required value={form.endDate} onChange={set('endDate')} />
          </Field>
        </div>
        <p className="muted">Events close by themselves 3 days after they end. You can reopen them.</p>
        <footer>
          <button className="primary" disabled={busy}>
            Save
          </button>
        </footer>
      </form>

      {event && (
        <>
          <hr />
          <h2>Status</h2>
          <p>
            <EventStatus open={event.open} />{' '}
            {event.open ? (
              <button onClick={() => act(() => api.post(`/api/events/${event.id}/close`))}>Close now</button>
            ) : (
              <button onClick={() => act(() => api.post(`/api/events/${event.id}/reopen`))}>Reopen</button>
            )}
          </p>
          <h2>Merge into another Event</h2>
          <p className="muted">Use this for duplicates like “Career Fair” and “Carreer fair”. Its Issues move to the Event you choose.</p>
          <div className="row">
            <select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
              <option value="">Choose the Event to keep…</option>
              {all
                .filter((x) => x.id !== event.id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({x.startDate})
                  </option>
                ))}
            </select>
            <button
              className="danger"
              style={{ flex: 0 }}
              disabled={!mergeInto || busy}
              onClick={() => confirm(`Merge “${event.name}” into the selected Event? This cannot be undone.`) && act(() => api.post(`/api/events/${event.id}/merge`, { intoId: mergeInto }))}
            >
              Merge
            </button>
          </div>
        </>
      )}
      <ErrorText error={error} />
    </Modal>
  );
}

export function EventReportPage() {
  const { id = '' } = useParams();
  const { data, error } = useApi<EventReport>(`/api/events/${id}/report`);
  if (!data) return <Loading error={error} />;
  const max = Math.max(1, ...data.lines.map((l) => l.pieces));
  return (
    <>
      <PageHeader title={data.event.name}>
        <Link to="/events">← All Events</Link>
        <button onClick={() => download(`/api/export/event.xlsx?id=${data.event.id}`)}>Export Excel</button>
        <button onClick={() => download(`/api/export/event.csv?id=${data.event.id}`)}>Export CSV</button>
      </PageHeader>
      <div className="stats">
        <div className="stat">
          <div className="label">Dates</div>
          <div className="value" style={{ fontSize: 16 }}>
            {data.event.startDate} → {data.event.endDate}
          </div>
        </div>
        <div className="stat">
          <div className="label">Status</div>
          <div className="value" style={{ fontSize: 16 }}>
            <EventStatus open={data.event.open} />
            {data.event.closedAtEffective && <div className="muted" style={{ fontSize: 12 }}>{data.event.open ? 'closes' : 'closed'} {fmtTime(data.event.closedAtEffective)}</div>}
          </div>
        </div>
        <div className="stat">
          <div className="label">Pieces issued</div>
          <div className="value">{fmtInt(data.totalPieces)}</div>
        </div>
        <div className="stat">
          <div className="label">Cost</div>
          <div className="value">{fmtMoney(data.totalCost)}</div>
        </div>
      </div>
      {data.lateSyncedIssues > 0 && (
        <p className="badge warn" style={{ fontSize: 13, padding: '6px 10px' }}>
          {data.lateSyncedIssues} Issue(s) reached the server after this Event closed. They are included because they were recorded while it was open.
        </p>
      )}
      <section className="panel">
        <h2>Gifts given out</h2>
        <table>
          <thead>
            <tr>
              <th>Gift</th>
              <th style={{ width: '35%' }} />
              <th className="num">Pieces</th>
              <th className="num">Unit cost</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.giftId}>
                <td>{l.name}</td>
                <td>
                  <div className="bar" style={{ width: `${(l.pieces / max) * 100}%` }} />
                </td>
                <td className="num">{fmtInt(l.pieces)}</td>
                <td className="num">{fmtMoney(l.unitCost)}</td>
                <td className="num">{fmtMoney(l.cost)}</td>
              </tr>
            ))}
            {data.lines.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Nothing issued yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h2>Issues</h2>
        <ActivityTable eventId={data.event.id} />
      </section>
    </>
  );
}
