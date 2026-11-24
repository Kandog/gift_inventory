import { useMemo, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { MovementKind } from '@gifts/shared';
import { confirmMode, createEvent, eventsFor, photoSource, recordEntry, useStore } from '@/lib/store';
import { Button, Card, color, ErrorText, Field, H, Input, Muted, Screen, Segmented, todayIso } from '@/ui';

const KINDS: { value: MovementKind; label: string }[] = [
  { value: 'receive', label: 'Receive' },
  { value: 'issue', label: 'Issue' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'writeoff', label: 'Write-off' },
];

export default function EntryScreen() {
  const router = useRouter();
  const { giftId } = useLocalSearchParams<{ giftId: string }>();
  const catalog = useStore((s) => s.catalog);
  const mode = useStore((s) => s.prefs.mode);
  const lastLocation = useStore((s) => s.prefs.locationId);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const outbox = useStore((s) => s.outbox);
  const events = useMemo(() => eventsFor({ catalog, outbox }), [catalog, outbox]);

  const gift = catalog?.gifts.find((g) => g.id === giftId);
  const locations = (catalog?.locations ?? []).filter((l) => !l.archived);
  const [kind, setKind] = useState<MovementKind>('issue');
  const [locationId, setLocationId] = useState<string | null>(locations.some((l) => l.id === lastLocation) ? lastLocation : (locations[0]?.id ?? null));
  const [toLocationId, setToLocationId] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [newEvent, setNewEvent] = useState<{ name: string; start: string; end: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!gift) {
    return (
      <Screen>
        <Muted>This Gift is not on the phone. Sync and try again.</Muted>
      </Screen>
    );
  }

  const isCount = mode === 'count';
  // One box per Pack plus loose Pieces, e.g. "3 Cartons + 12 Pieces" (all stored as Pieces).
  const units = [...gift.packs.map((p) => ({ key: p.name, label: `${p.name}s (×${p.pieces})`, pieces: p.pieces })).reverse(), { key: '', label: 'Pieces', pieces: 1 }];
  const pieces = units.reduce((sum, u) => sum + (Number(amounts[u.key] || 0) || 0) * u.pieces, 0);
  const anyAmount = units.some((u) => (amounts[u.key] ?? '').trim() !== '');
  const level = (locId: string | null) => (locId ? (catalog?.stock.find((s) => s.giftId === gift.id && s.locationId === locId)?.pieces ?? 0) : 0);
  const openEvents = events.filter((e) => e.open);
  const photo = gift.hasPhoto ? photoSource(gift.id) : null;

  const save = async () => {
    setError(null);
    if (!locationId) return setError('Choose a Location.');
    if (!anyAmount || !Number.isInteger(pieces) || pieces < 0) return setError('Enter a whole number.');
    if (!isCount && pieces === 0) return setError('Enter more than zero.');
    if (!isCount && kind === 'transfer' && (!toLocationId || toLocationId === locationId)) return setError('Choose where the Gifts are going.');
    if (!isCount && kind === 'issue' && !eventId && !newEvent) return setError('Choose the Event, or create one.');
    if (newEvent && (!newEvent.name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(newEvent.start) || !/^\d{4}-\d{2}-\d{2}$/.test(newEvent.end) || newEvent.end < newEvent.start)) {
      return setError('Give the new Event a name and valid dates (YYYY-MM-DD).');
    }
    setBusy(true);
    try {
      let evId = eventId;
      if (!isCount && kind === 'issue' && newEvent) evId = (await createEvent(newEvent.name, newEvent.start, newEvent.end)).id;
      await recordEntry({
        kind: isCount ? 'count' : kind,
        giftId: gift.id,
        locationId,
        toLocationId: !isCount && kind === 'transfer' ? toLocationId : null,
        eventId: !isCount && kind === 'issue' ? evId : null,
        quantity: pieces,
        note: note.trim() || null,
      });
      router.back();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const summary = isCount
    ? `Set to ${pieces} Pieces`
    : `${kind === 'receive' ? '+' : kind === 'transfer' ? 'Move ' : '−'}${pieces} Pieces`;

  return (
    <Screen>
      <Stack.Screen options={{ title: isCount ? 'Count' : 'Movement' }} />
      <Card>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
          {photo && <Image source={photo} style={{ width: 64, height: 64, borderRadius: 8, backgroundColor: '#eef1f5' }} />}
          <View style={{ flex: 1 }}>
            <H>{gift.name}</H>
            {gift.archived && <Text style={{ color: color.warn }}>Archived Gift</Text>}
          </View>
        </View>
        <Segmented
          value={mode}
          options={[
            { value: 'count', label: '🔢 Count' },
            { value: 'movement', label: '⇄ Movement' },
          ]}
          onChange={(m) => void confirmMode(m)}
        />
      </Card>

      {!isCount && (
        <Card>
          <Field label="What happened?">
            <Segmented value={kind} options={KINDS} onChange={setKind} />
          </Field>
        </Card>
      )}

      <Card>
        <Field label={isCount ? 'Where are you counting?' : kind === 'transfer' ? 'From' : 'Where?'}>
          <Segmented
            value={locationId}
            options={locations.map((l) => ({ value: l.id, label: `${l.name} (${level(l.id)})` }))}
            onChange={setLocationId}
          />
        </Field>
        {!isCount && kind === 'transfer' && (
          <Field label="To">
            <Segmented value={toLocationId} options={locations.filter((l) => l.id !== locationId).map((l) => ({ value: l.id, label: l.name }))} onChange={setToLocationId} />
          </Field>
        )}
        <Muted>Stock shown as of the last sync ({lastSyncAt ? new Date(lastSyncAt).toLocaleString() : 'never'}).</Muted>
      </Card>

      {!isCount && kind === 'issue' && (
        <Card>
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
        </Card>
      )}

      <Card>
        <Field label={isCount ? 'How many are there?' : 'How many?'}>
          {units.map((u) => (
            <View key={u.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Input
                style={{ flex: 1, fontSize: 22, textAlign: 'right' }}
                keyboardType="number-pad"
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
      <Button big title="Save" busy={busy} onPress={save} />
      {isCount && (
        <Muted>A Count replaces the stock at this Location as of now. Movements recorded after this moment still apply on top.</Muted>
      )}
      {!isCount && kind === 'issue' && level(locationId) - pieces < 0 && anyAmount && (
        <Text style={{ color: color.warn }}>That is more than the phone thinks is here. It will still be saved, and an Admin will see the difference.</Text>
      )}
    </Screen>
  );
}

