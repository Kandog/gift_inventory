import { useMemo, useState } from 'react';
import { download } from '../api';
import type { StockReport } from '../reportTypes';
import { fmtInt, fmtMoney, Loading, PageHeader, useApi } from '../ui';

export function StockPage() {
  const [showArchived, setShowArchived] = useState(false);
  const { data, error } = useApi<StockReport>(`/api/reports/stock${showArchived ? '?archived=1' : ''}`);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);

  const categories = useMemo(() => [...new Set((data?.rows ?? []).map((r) => r.category).filter(Boolean))].sort() as string[], [data]);
  const rows = useMemo(() => {
    const q = query.toLowerCase();
    return (data?.rows ?? []).filter(
      (r) =>
        (!q || r.name.toLowerCase().includes(q)) &&
        (!category || r.category === category) &&
        (!onlyProblems || r.low || r.negative),
    );
  }, [data, query, category, onlyProblems]);

  if (!data) return <Loading error={error} />;
  const totals = data.locations.map((l) => rows.reduce((s, r) => s + (r.byLocation[l.id] ?? 0), 0));

  return (
    <>
      <PageHeader title="Stock">
        <button onClick={() => download('/api/export/stock.xlsx')}>Export Excel</button>
        <button onClick={() => download('/api/export/stock.csv')}>Export CSV</button>
      </PageHeader>
      <div className="filters">
        <input placeholder="Search Gifts…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <label className="row" style={{ minWidth: 0, alignItems: 'center' }}>
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Low or negative only
        </label>
        <label className="row" style={{ minWidth: 0, alignItems: 'center' }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Include archived
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Gift</th>
              <th>Category</th>
              {data.locations.map((l) => (
                <th key={l.id} className="num">
                  {l.name}
                </th>
              ))}
              <th className="num">Total</th>
              <th className="num">Value</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.giftId}>
                <td>
                  {r.name} {r.archived && <span className="badge">archived</span>}
                </td>
                <td className="muted">{r.category ?? '—'}</td>
                {data.locations.map((l) => {
                  const v = r.byLocation[l.id] ?? 0;
                  return (
                    <td key={l.id} className={`num ${v < 0 ? 'neg' : ''}`}>
                      {v === 0 ? <span className="muted">0</span> : fmtInt(v)}
                    </td>
                  );
                })}
                <td className={`num ${r.negative ? 'neg' : r.low ? 'low' : ''}`}>{fmtInt(r.total)}</td>
                <td className="num">{fmtMoney(r.value)}</td>
                <td>
                  {r.negative ? <span className="badge bad">negative</span> : r.low ? <span className="badge warn">low</span> : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={data.locations.length + 5} className="muted">
                  No Gifts match.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>Total ({rows.length} Gifts)</th>
              {totals.map((t, i) => (
                <th key={i} className="num">
                  {fmtInt(t)}
                </th>
              ))}
              <th className="num">{fmtInt(totals.reduce((a, b) => a + b, 0))}</th>
              <th className="num">{fmtMoney(rows.reduce((s, r) => s + (r.value ?? 0), 0))}</th>
              <th />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
