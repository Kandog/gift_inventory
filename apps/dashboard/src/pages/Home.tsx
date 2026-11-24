import { Link } from 'react-router-dom';
import type { Alerts, EventSummary, StockReport } from '../reportTypes';
import { fmtAgo, fmtInt, fmtMoney, Loading, PageHeader, useApi } from '../ui';
import { ActivityTable } from './Activity';

export function HomePage() {
  const alerts = useApi<Alerts>('/api/reports/alerts');
  const stock = useApi<StockReport>('/api/reports/stock');
  const events = useApi<EventSummary[]>('/api/events');

  if (!alerts.data || !stock.data || !events.data) return <Loading error={alerts.error ?? stock.error ?? events.error} />;
  const a = alerts.data;
  const totalPieces = stock.data.rows.reduce((s, r) => s + r.total, 0);
  const openEvents = events.data.filter((e) => e.open);
  const alertCount = a.lowStock.length + a.negativeStock.length + a.staleDevices.length + (a.backup.overdue ? 1 : 0);

  return (
    <>
      <PageHeader title="Home" />
      <div className="stats">
        <div className="stat">
          <div className="label">Gifts</div>
          <div className="value">{fmtInt(stock.data.rows.length)}</div>
        </div>
        <div className="stat">
          <div className="label">Pieces in stock</div>
          <div className="value">{fmtInt(totalPieces)}</div>
        </div>
        <div className="stat">
          <div className="label">Stock value</div>
          <div className="value">{fmtMoney(stock.data.totalValue)}</div>
        </div>
        <div className="stat">
          <div className="label">Open Events</div>
          <div className="value">{openEvents.length}</div>
        </div>
        <div className={`stat ${alertCount ? 'bad' : ''}`}>
          <div className="label">Alerts</div>
          <div className="value">{alertCount}</div>
        </div>
      </div>

      <div className="grid-2">
        <section className="panel">
          <h2>Alerts</h2>
          {alertCount === 0 && <p className="muted">Nothing needs attention. ✅</p>}
          {a.backup.overdue && (
            <p className="error">
              ⚠ Backup overdue: last good backup {fmtAgo(a.backup.lastSuccessAt)}.{' '}
              {a.backup.lastError ? <>Last error: {a.backup.lastError}. </> : null}
              <Link to="/settings">Check backup settings</Link>
            </p>
          )}
          {a.negativeStock.length > 0 && (
            <>
              <h3>Negative stock</h3>
              <p className="muted">More was given out than was recorded. Do a Count at these Locations.</p>
              <ul className="plain">
                {a.negativeStock.map((n) => (
                  <li key={n.giftId + n.locationId}>
                    <span>
                      {n.name} @ {n.location}
                    </span>
                    <span className="neg">{fmtInt(n.pieces)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {a.lowStock.length > 0 && (
            <>
              <h3>Low stock</h3>
              <ul className="plain">
                {a.lowStock.map((l) => (
                  <li key={l.giftId}>
                    <span>{l.name}</span>
                    <span className="low">
                      {fmtInt(l.total)} <span className="muted">/ threshold {fmtInt(l.threshold)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {a.staleDevices.length > 0 && (
            <>
              <h3>Phones not synced for 7+ days</h3>
              <p className="muted">Their entries are not on the server yet. Ask the owner to open the app on the office Wi-Fi.</p>
              <ul className="plain">
                {a.staleDevices.map((d) => (
                  <li key={d.id}>
                    <span>
                      {d.name} {d.lastUserName && <span className="muted">({d.lastUserName})</span>}
                    </span>
                    <span className="muted">{fmtAgo(d.lastSyncAt)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="panel">
          <h2>Open Events</h2>
          {openEvents.length === 0 && <p className="muted">No open Events.</p>}
          <ul className="plain">
            {openEvents.map((e) => (
              <li key={e.id}>
                <Link to={`/events/${e.id}`}>{e.name}</Link>
                <span className="muted">
                  {fmtInt(e.piecesIssued)} pcs · {fmtMoney(e.cost)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="panel">
        <h2>
          Latest activity <Link to="/activity" style={{ fontSize: 13, fontWeight: 400 }}>see all</Link>
        </h2>
        <ActivityTable limit={10} compact />
      </section>
    </>
  );
}
