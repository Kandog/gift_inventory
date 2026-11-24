import { useState } from 'react';
import type { Category, Location } from '@gifts/shared';
import { api } from '../api';
import { ErrorText, Loading, PageHeader, useAction, useApi } from '../ui';

export function LocationsPage() {
  const locations = useApi<Location[]>('/api/locations');
  const categories = useApi<Category[]>('/api/categories');
  if (!locations.data || !categories.data) return <Loading error={locations.error ?? categories.error} />;
  return (
    <>
      <PageHeader title="Locations & categories" />
      <div className="grid-2">
        <section className="panel">
          <h2>Locations</h2>
          <p className="muted">Places where Gifts are kept. Stock is tracked separately at each one.</p>
          <NamedList
            items={locations.data}
            archivable
            onAdd={(name) => api.post('/api/locations', { name })}
            onRename={(id, name) => api.put(`/api/locations/${id}`, { name })}
            onArchive={(id, archived) => api.put(`/api/locations/${id}`, { archived })}
            reload={locations.reload}
          />
        </section>
        <section className="panel">
          <h2>Categories</h2>
          <p className="muted">Groupings for Gifts, such as Bags, Pens or Toys.</p>
          <NamedList
            items={categories.data}
            onAdd={(name) => api.post('/api/categories', { name })}
            onRename={(id, name) => api.put(`/api/categories/${id}`, { name })}
            reload={categories.reload}
          />
        </section>
      </div>
    </>
  );
}

function NamedList({
  items,
  archivable,
  onAdd,
  onRename,
  onArchive,
  reload,
}: {
  items: { id: string; name: string; archived?: boolean }[];
  archivable?: boolean;
  onAdd: (name: string) => Promise<unknown>;
  onRename: (id: string, name: string) => Promise<unknown>;
  onArchive?: (id: string, archived: boolean) => Promise<unknown>;
  reload: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const { busy, error, run } = useAction();
  const act = async (fn: () => Promise<unknown>) => {
    if (await run(fn)) {
      setEditing(null);
      await reload();
    }
  };

  return (
    <>
      <ul className="plain">
        {items.map((it) => (
          <li key={it.id}>
            {editing?.id === it.id ? (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(() => onRename(it.id, editing.name));
                }}
              >
                <input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                <button className="small primary" style={{ flex: 0 }} disabled={busy}>
                  Save
                </button>
              </form>
            ) : (
              <span>
                {it.name} {it.archived && <span className="badge">archived</span>}
              </span>
            )}
            <span className="actions">
              <button className="small" onClick={() => setEditing({ id: it.id, name: it.name })}>
                Rename
              </button>
              {archivable && onArchive && (
                <button className="small" onClick={() => act(() => onArchive(it.id, !it.archived))}>
                  {it.archived ? 'Restore' : 'Archive'}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <form
        className="row"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => onAdd(name)).then(() => setName(''));
        }}
      >
        <input placeholder="New name…" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" style={{ flex: 0 }} disabled={busy || !name.trim()}>
          Add
        </button>
      </form>
      <ErrorText error={error} />
    </>
  );
}
