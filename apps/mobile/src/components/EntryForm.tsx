import { useMemo, useState } from 'react';
import { Image, Text, View } from 'react-native';
import type { Gift } from '@gifts/shared';
import { createEvent, ENTRY_TYPES, eventsFor, photoSource, recordEntry, useStore, type EntryType } from '@/lib/store';
import { Button, Card, color, ErrorText, Field, H, Input, Muted, Segmented, todayIso } from '@/ui';


/** Everything after the Gift is picked: where, how many, and the extra field each entry type needs. */
export function EntryForm({ gift, type, onSaved, onChangeGift }: { gift: Gift; type: EntryType; onSaved: (summary: string) => void; onChangeGift: () => void }) {
  const catalog = useStore((s) => s.catalog);
  const lastLocation = useStore((s) => s.prefs.locationId);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const outbox = useStore((s) => s.outbox);
  const events = useMemo(() => eventsFor({ catalog, outbox }), [catalog, outbox]);

  const locations = (catalog?.locations ?? []).filter((l) => !l.archived);
  const [locationId, setLocationId] = useState<string | null>(locations.some((l) => l.id === lastLocation) ? lastLocation : (locations[0]?.id ?? null));
  const [toLocationId, setToLocationId] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [newEvent, setNewEvent] = useState<{ name: string; start: string; end: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isCount = type === 'count';
  const typeLabel = ENTRY_TYPES.find((t) => t.value === type)!.label;
  // One box per Pack plus loose Pieces, e.g. "3 Cartons + 12 Pieces" (all stored as Pieces).
  const units = [...gift.packs.map((p) => ({ key: p.name, label: `${p.name}s (×${p.pieces})`, pieces: p.pieces })).reverse(), { key: '', label: 'Pieces', pieces: 1 }];
  const pieces = units.reduce((sum, u) => sum + (Number(amounts[u.key] || 0) || 0) * u.pieces, 0);
  const anyAmount = units.some((u) => (amounts[u.key] ?? '').trim() !== '');
  const level = (locId: string | null) => (locId ? (catalog?.stock.find((s) => s.giftId === gift.id && s.locationId === locId)?.pieces ?? 0) : 0);
  const openEvents = events.filter((e) => e.open);
  const photo = gift.hasPhoto ? photoSource(gift.id) : null;
  const locName = (id: string | null) => locations.find((l) => l.id === id)?.name ?? '';

  const summary = isCount
    ? `Set to ${pieces} Pieces`
    : type === 'receive'
      ? `+${pieces} Pieces`
      : type === 'transfer'
        ? `Move ${pieces} Pieces`
        : `−${pieces} Pieces`;

  const save = async () => {
    setError(null);
    if (!locationId) return setError('Choose a Location.');
    if (!anyAmount || !Number.isInteger(pieces) || pieces < 0) return setError('Enter a whole number.');
    if (!isCount && pieces === 0) return setError('Enter more than zero.');
    if (type === 'transfer' && (!toLocationId || toLocationId === locationId)) return setError('Choose where the Gifts are going.');
    if (type === 'issue' && !eventId && !newEvent) return setError('Choose the Event, or create one.');
    if (type === 'issue' && newEvent && (!newEvent.name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(newEvent.start) || !/^\d{4}-\d{2}-\d{2}$/.test(newEvent.end) || newEvent.end < newEvent.start)) {
      return setError('Give the new Event a name and valid dates (YYYY-MM-DD).');
    }
    setBusy(true);
    try {
      let evId = eventId;
      if (type === 'issue' && newEvent) evId = (await createEvent(newEvent.name, newEvent.start, newEvent.end)).id;
      await recordEntry({
        kind: type,
        giftId: gift.id,
        locationId,
        toLocationId: type === 'transfer' ? toLocationId : null,
        eventId: type === 'issue' ? evId : null,
        quantity: pieces,
        note: note.trim() || null,
      });
      const where = type === 'transfer' ? `${locName(locationId)} → ${locName(toLocationId)}` : locName(locationId);
      onSaved(`${typeLabel}: ${summary}, ${gift.name}, ${where}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          {photo && <Image source={photo} style={{ width: 56, height: 56, borderRadius: 8, backgroundColor: '#eef1f5' }} />}
          <View style={{ flex: 1 }}>
            <H>{gift.name}</H>
            {gift.archived && <Text style={{ color: color.warn }}>Archived Gift</Text>}
          </View>
        </View>
        <Button kind="secondary" title="Change Gift" onPress={onChangeGift} />
      </Card>

      <Card>
        <Field label={isCount ? 'Where are you counting?' : type === 'transfer' ? 'From' : 'Where?'}>
          <Segmented value={locationId} options={locations.map((l) => ({ value: l.id, label: `${l.name} (${level(l.id)})` }))} onChange={setLocationId} />
        </Field>
        {type === 'transfer' && (
          <Field label="To">
            <Segmented value={toLocationId} options={locations.filter((l) => l.id !== locationId).map((l) => ({ value: l.id, label: l.name }))} onChange={setToLocationId} />
          </Field>
        )}
        <Muted>Stock shown as of the last sync ({lastSyncAt ? new Date(lastSyncAt).toLocaleString() : 'never'}).</Muted>

        {type === 'issue' && (
          <Field label="Event">
            {newEvent ? (
              <View style={{ gap: 8 }}>
                <Input value={newEvent.name} onChangeText={(name) => setNewEvent({ ...newEvent, name })} placeholder="Event name, e.g. Fall Career Fair" />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Input style={{ flex: 1 }} value={newEvent.start} onChangeText={(start) => setNewEvent({ ...newEvent, start })} placeholder="Start YYYY-MM-DD" />
                  <Input style={{ flex: 1 }} value={newEvent.end} onChangeText={(end) => setNewEvent({ ...newEvent, end })} placeholder="End YYYY-MM-DD" />
                </View>
                <Button kind="secondary" title="Pick an existing Event instead" onPress={() => setNewEvent(null)} />
              </View>
            ) : (
              <View style={{ gap: 8 }}>
                {openEvents.length ? (
                  <Segmented value={eventId} options={openEvents.map((e) => ({ value: e.id, label: e.name + (e.pending ? ' (new)' : '') }))} onChange={setEventId} />
                ) : (
                  <Muted>No open Events.</Muted>
                )}
                <Button kind="secondary" title="+ New Event" onPress={() => setNewEvent({ name: '', start: todayIso(), end: todayIso() })} />
              </View>
            )}
          </Field>
        )}

        <Field label={isCount ? 'How many are there?' : 'How many?'}>
          {units.map((u, i) => (
            <View key={u.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Input
                style={{ flex: 1, fontSize: 22, textAlign: 'right' }}
                keyboardType="number-pad"
                autoFocus={i === 0}
                value={amounts[u.key] ?? ''}
                onChangeText={(v) => setAmounts({ ...amounts, [u.key]: v.replace(/[^0-9]/g, '') })}
                placeholder="0"
              />
              <Text style={{ width: 140, fontSize: 16 }}>{u.label}</Text>
            </View>
          ))}
        </Field>
        <Text style={{ fontSize: 18, fontWeight: '700' }}>{summary}</Text>
        <Field label="Note (optional)">
          <Input value={note} onChangeText={setNote} placeholder="e.g. PO number, damage" />
        </Field>
      </Card>

      <ErrorText error={error} />
      {type === 'issue' && level(locationId) - pieces < 0 && anyAmount && (
        <Text style={{ color: color.warn }}>That is more than the phone thinks is here. It will still be saved, and an Admin will see the difference.</Text>
      )}
      <Button big title={`Save ${typeLabel}`} busy={busy} onPress={save} />
    </>
  );
}
