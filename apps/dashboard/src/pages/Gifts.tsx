import { useMemo, useState, type FormEvent } from 'react';
import type { Gift, Pack } from '@gifts/shared';
import { api, download } from '../api';
import { useLookups } from '../lookups';
import { ErrorText, Field, fmtMoney, Loading, Modal, PageHeader, useAction } from '../ui';

export function GiftsPage() {
  const lk = useLookups();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Gift | 'new' | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState(false);
  const [importing, setImporting] = useState(false);

  const rows = useMemo(() => {
    const q = query.toLowerCase();
    return lk.gifts.filter(
      (g) =>
        (showArchived || !g.archived) &&
        (!category || g.categoryId === category) &&
        (!q || g.name.toLowerCase().includes(q) || g.barcodes.some((b) => b.includes(q))),
    );
  }, [lk.gifts, query, category, showArchived]);

  if (!lk.ready) return <Loading />;
  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  const allSelected = rows.length > 0 && rows.every((g) => selected.has(g.id));

  return (
    <>
      <PageHeader title="Gifts & labels">
        <button onClick={() => setImporting(true)}>Import spreadsheet</button>
        <button disabled={selected.size === 0} onClick={() => setPrinting(true)}>
          Print labels ({selected.size})
        </button>
        <button className="primary" onClick={() => setEditing('new')}>
          + New Gift
        </button>
      </PageHeader>
      <div className="filters">
        <input placeholder="Search name or barcode…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {lk.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="row" style={{ minWidth: 0, alignItems: 'center' }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((g) => g.id)))}
                  aria-label="Select all"
                />
              </th>
              <th style={{ width: 48 }} />
              <th>Name</th>
              <th>Category</th>
              <th className="num">Unit cost</th>
              <th className="num">Low at</th>
              <th>Packs</th>
              <th>Barcodes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.id} className="clickable" onClick={() => setEditing(g)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(g.id)} onChange={() => toggle(g.id)} aria-label={`Select ${g.name}`} />
                </td>
                <td>{g.hasPhoto ? <img className="thumb" src={photoUrl(g)} alt="" /> : <div className="thumb" />}</td>
                <td>
                  {g.name} {g.archived && <span className="badge">archived</span>}
                </td>
                <td className="muted">{lk.catName(g.categoryId) || '—'}</td>
                <td className="num">{fmtMoney(g.unitCost)}</td>
                <td className="num">{g.lowStockThreshold ?? '—'}</td>
                <td className="muted">{g.packs.map((p) => `${p.name} ×${p.pieces}`).join(', ') || '—'}</td>
                <td className="muted">{g.barcodes.length || '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No Gifts yet. Add one, or import a spreadsheet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && (
        <GiftModal
          gift={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await lk.reload();
          }}
        />
      )}
      {printing && <LabelsModal gifts={lk.gifts.filter((g) => selected.has(g.id))} onClose={() => setPrinting(false)} />}
      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onDone={() => {
            void lk.reload();
          }}
        />
      )}
    </>
  );
}

// Cache-bust when a photo changes: the URL is stable per Gift.
const photoUrl = (g: Gift) => `/api/gifts/${g.id}/photo?v=${g.hasPhoto ? '1' : '0'}-${photoVersion}`;
let photoVersion = Date.now();

function GiftModal({ gift, onClose, onSaved }: { gift: Gift | null; onClose: () => void; onSaved: () => void }) {
  const lk = useLookups();
  const [form, setForm] = useState({
    name: gift?.name ?? '',
    categoryId: gift?.categoryId ?? '',
    newCategory: '',
    unitCost: gift?.unitCost?.toString() ?? '',
    lowStockThreshold: gift?.lowStockThreshold?.toString() ?? '',
    archived: gift?.archived ?? false,
  });
  const [packs, setPacks] = useState<Pack[]>(gift?.packs ?? []);
  const [barcodes, setBarcodes] = useState((gift?.barcodes ?? []).join('\n'));
  const [photo, setPhoto] = useState<File | null>(null);
  const { busy, error, run } = useAction();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(async () => {
      let categoryId: string | null = form.categoryId || null;
      if (form.categoryId === '__new') {
        const c = await api.post<{ id: string }>('/api/categories', { name: form.newCategory });
        categoryId = c.id;
      }
      const body = {
        name: form.name,
        categoryId,
        unitCost: form.unitCost === '' ? null : Number(form.unitCost),
        lowStockThreshold: form.lowStockThreshold === '' ? null : Number(form.lowStockThreshold),
        archived: form.archived,
        packs: packs.filter((p) => p.name.trim()).map((p) => ({ name: p.name, pieces: Number(p.pieces) })),
        barcodes: barcodes.split(/[\s,;]+/).filter(Boolean),
      };
      const saved = gift ? await api.put<Gift>(`/api/gifts/${gift.id}`, body) : await api.post<Gift>('/api/gifts', body);
      if (photo) {
        await api.upload(`/api/gifts/${saved.id}/photo`, photo);
        photoVersion = Date.now();
      }
    });
    if (ok) onSaved();
  };

  const removePhoto = async () => {
    if (gift && (await run(() => api.del(`/api/gifts/${gift.id}/photo`)))) {
      photoVersion = Date.now();
      onSaved();
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <Modal title={gift ? `Edit “${gift.name}”` : 'New Gift'} onClose={onClose} wide>
      <form onSubmit={save}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div>
            <Field label="Name">
              <input autoFocus required value={form.name} onChange={set('name')} placeholder="e.g. Blue logo pen" />
            </Field>
            <Field label="Category">
              <select value={form.categoryId} onChange={set('categoryId')}>
                <option value="">None</option>
                {lk.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                <option value="__new">+ New category…</option>
              </select>
            </Field>
            {form.categoryId === '__new' && (
              <Field label="New category name">
                <input required value={form.newCategory} onChange={set('newCategory')} />
              </Field>
            )}
            <div className="row">
              <Field label="Unit cost ($)">
                <input type="number" min={0} step="0.01" value={form.unitCost} onChange={set('unitCost')} />
              </Field>
              <Field label="Low-Stock Threshold" hint="Total Pieces across all Locations">
                <input type="number" min={0} step={1} value={form.lowStockThreshold} onChange={set('lowStockThreshold')} />
              </Field>
            </div>
          </div>
          <div style={{ flex: '0 0 160px' }}>
            <Field label="Photo">
              {gift?.hasPhoto && !photo ? <img className="photo" src={photoUrl(gift)} alt="" /> : photo ? <img className="photo" src={URL.createObjectURL(photo)} alt="" /> : <div className="photo" />}
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
              {gift?.hasPhoto && (
                <button type="button" className="small danger" onClick={removePhoto}>
                  Remove photo
                </button>
              )}
            </Field>
          </div>
        </div>

        <Field label="Packs" hint="Shortcuts for entering quantities, e.g. Carton = 50 Pieces. Stock is always kept in Pieces.">
          <div>
            {packs.map((p, i) => (
              <div className="row" key={i} style={{ marginBottom: 6 }}>
                <input placeholder="Name, e.g. Carton" value={p.name} onChange={(e) => setPacks(packs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input type="number" min={2} placeholder="Pieces" value={p.pieces || ''} onChange={(e) => setPacks(packs.map((x, j) => (j === i ? { ...x, pieces: Number(e.target.value) } : x)))} />
                <button type="button" className="small" style={{ flex: 0 }} onClick={() => setPacks(packs.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            ))}
            <button type="button" className="small" onClick={() => setPacks([...packs, { name: '', pieces: 0 }])}>
              + Add Pack
            </button>
          </div>
        </Field>

        <Field label="Barcodes" hint="Codes already printed on the packaging (EAN/UPC), one per line. Phones can also link these when they scan an unknown one.">
          <textarea value={barcodes} onChange={(e) => setBarcodes(e.target.value)} />
        </Field>

        <label className="row" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={form.archived} onChange={(e) => setForm({ ...form, archived: e.target.checked })} style={{ flex: 0 }} />
          <span>Archived: hidden from new entries, history kept</span>
        </label>

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

function LabelsModal({ gifts, onClose }: { gifts: Gift[]; onClose: () => void }) {
  const [copies, setCopies] = useState<Record<string, number>>(Object.fromEntries(gifts.map((g) => [g.id, 1])));
  const [sheet, setSheet] = useState<'letter-30' | 'a4-21'>('letter-30');
  const [skip, setSkip] = useState(0);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const perSheet = sheet === 'letter-30' ? 30 : 21;
  const total = Object.values(copies).reduce((a, b) => a + b, 0);

  const print = () =>
    run(async () => {
      const blob = await api.post<Blob>('/api/labels.pdf', { sheet, skip, items: gifts.map((g) => ({ giftId: g.id, copies: copies[g.id] ?? 1 })) });
      setPdfUrl(URL.createObjectURL(blob));
    });

  return (
    <Modal title="Print Gift Labels" onClose={onClose}>
      <div className="row">
        <Field label="Sticker sheet">
          <select value={sheet} onChange={(e) => (setSheet(e.target.value as typeof sheet), setPdfUrl(null))}>
            <option value="letter-30">US Letter, 30 per sheet (Avery 5160)</option>
            <option value="a4-21">A4, 21 per sheet (Avery L7160)</option>
          </select>
        </Field>
        <Field label="Skip used stickers" hint="On a part-used sheet">
          <input type="number" min={0} max={perSheet - 1} value={skip} onChange={(e) => (setSkip(Number(e.target.value)), setPdfUrl(null))} />
        </Field>
      </div>
      <ul className="plain">
        {gifts.map((g) => (
          <li key={g.id}>
            <span>{g.name}</span>
            <input
              type="number"
              min={1}
              max={500}
              style={{ width: 80 }}
              value={copies[g.id] ?? 1}
              onChange={(e) => (setCopies({ ...copies, [g.id]: Math.max(1, Number(e.target.value)) }), setPdfUrl(null))}
              aria-label={`Copies of ${g.name}`}
            />
          </li>
        ))}
      </ul>
      <p className="muted">
        {total} labels on {Math.ceil((total + skip) / perSheet)} sheet(s). Print at 100% scale (“Actual size”), not “Fit to page”.
      </p>
      <ErrorText error={error} />
      <footer>
        <button onClick={onClose}>Close</button>
        {pdfUrl ? (
          <a className="button primary" href={pdfUrl} target="_blank" rel="noreferrer" style={{ background: 'var(--accent)', color: '#fff' }}>
            Open labels PDF
          </a>
        ) : (
          <button className="primary" disabled={busy} onClick={print}>
            Make PDF
          </button>
        )}
      </footer>
    </Modal>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number; counts: number; errors: { row: number; message: string }[] } | null>(null);
  const { busy, error, run } = useAction();
  const submit = () =>
    run(async () => {
      setResult(await api.upload('/api/import/gifts', file!));
      onDone();
    });

  return (
    <Modal title="Import Gifts from a spreadsheet" onClose={onClose}>
      <ol className="muted" style={{ paddingLeft: 18 }}>
        <li>
          <button className="small" onClick={() => download('/api/import/template.xlsx')}>
            Download the template
          </button>{' '}
          and fill one row per Gift.
        </li>
        <li>Gifts are matched by name: existing ones are updated, new ones are created.</li>
        <li>
          Numbers in <code>Stock: &lt;Location&gt;</code> columns are recorded as Counts. Add a column per Location; missing Locations are created.
        </li>
        <li>Packs look like <code>Carton=50; Box=10</code>. Separate several barcodes with <code>;</code>.</li>
      </ol>
      <input type="file" accept=".xlsx,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      {result && (
        <div className="panel" style={{ marginTop: 12 }}>
          <strong>
            Created {result.created}, updated {result.updated}, recorded {result.counts} Counts.
          </strong>
          {result.errors.length > 0 && (
            <ul className="error">
              {result.errors.map((e, i) => (
                <li key={i}>
                  {e.row ? `Row ${e.row}: ` : ''}
                  {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ErrorText error={error} />
      <footer>
        <button onClick={onClose}>Close</button>
        <button className="primary" disabled={!file || busy} onClick={submit}>
          Import
        </button>
      </footer>
    </Modal>
  );
}
