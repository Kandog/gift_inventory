import { useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { Redirect, Stack, useRouter } from 'expo-router';
import { resolveScan, searchGifts } from '@gifts/shared';
import { EntryForm } from '@/components/EntryForm';
import { Scanner } from '@/components/Scanner';
import { SyncBar } from '@/components/SyncBar';
import { ENTRY_TYPES, getState, pickGift, useStore } from '@/lib/store';
import { Button, Card, color, H, Input, Muted, Row, Screen } from '@/ui';

const MAX_LIST = 50;

/** The recording flow on one screen: Gift (scan or type), how many, Save. The entry type is chosen on /start. */
export default function HomeScreen() {
  const router = useRouter();
  const typeConfirmed = useStore((s) => s.typeConfirmed);
  const type = useStore((s) => s.prefs.entryType);
  const catalog = useStore((s) => s.catalog);
  const user = useStore((s) => s.user);
  const pickedGiftId = useStore((s) => s.pickedGiftId);
  const [query, setQuery] = useState('');
  const [scanning, setScanning] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const categoryName = useMemo(() => {
    const m = new Map((catalog?.categories ?? []).map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? (m.get(id) ?? '') : '');
  }, [catalog]);
  const totals = useMemo(() => {
    const t = new Map<string, number>();
    for (const s of catalog?.stock ?? []) t.set(s.giftId, (t.get(s.giftId) ?? 0) + s.pieces);
    return t;
  }, [catalog]);
  const gifts = useMemo(() => searchGifts(query, catalog?.gifts ?? [], categoryName), [query, catalog, categoryName]);
  const gift = catalog?.gifts.find((g) => g.id === pickedGiftId) ?? null;

  const choose = (giftId: string) => {
    setSaved(null);
    setScanning(false);
    pickGift(giftId);
  };

  const onScan = (data: string) => {
    const result = resolveScan(data, getState().catalog?.gifts ?? []);
    setScanning(false);
    if (result.type === 'gift') choose(result.gift.id);
    else if (result.type === 'unknown-barcode') router.push({ pathname: '/link', params: { code: result.code } });
    else Alert.alert('Gift not on this phone yet', 'This label is for a Gift this phone has not downloaded. Sync on the office Wi-Fi and try again.');
  };

  if (!typeConfirmed || !type) return <Redirect href="/start" />;
  const typeInfo = ENTRY_TYPES.find((t) => t.value === type)!;

  return (
    <Screen>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => router.push('/settings')} hitSlop={12} accessibilityLabel="Settings">
              <Text style={{ fontSize: 22 }}>⚙︎</Text>
            </Pressable>
          ),
        }}
      />
      <SyncBar />

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <H>{typeInfo.label}</H>
            <Muted>{typeInfo.hint}</Muted>
          </View>
          <Button kind="secondary" title="Change" onPress={() => router.push('/start')} />
        </View>
      </Card>

      {saved && (
        <Card style={{ borderColor: color.ok, backgroundColor: '#e3f4e9' }}>
          <Text style={{ fontWeight: '600' }}>✓ Saved. {saved}</Text>
        </Card>
      )}

      {gift && (
        <EntryForm
          key={gift.id}
          gift={gift}
          type={type}
          onChangeGift={() => pickGift(null)}
          onSaved={(summary) => {
            setSaved(summary);
            setQuery('');
            pickGift(null);
          }}
        />
      )}

      {!gift && (
        <>
          {scanning ? (
            <View style={{ height: 320, borderRadius: 12, overflow: 'hidden' }}>
              <Scanner onScan={onScan} hint="Point at a Gift Label or the barcode on the packaging" />
              <Pressable
                onPress={() => setScanning(false)}
                accessibilityRole="button"
                style={{ position: 'absolute', top: 10, left: 10, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 }}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>✕ Close</Text>
              </Pressable>
            </View>
          ) : (
            <Button big title="📷  Scan a Gift" onPress={() => setScanning(true)} />
          )}
          <Input value={query} onChangeText={setQuery} placeholder="…or type a Gift name" autoCorrect={false} clearButtonMode="while-editing" />
          <View>
            {gifts.slice(0, MAX_LIST).map((item) => (
              <Row key={item.id} onPress={() => choose(item.id)}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 16, fontWeight: '600' }}>{item.name}</Text>
                  <Muted>{categoryName(item.categoryId) || ' '}</Muted>
                </View>
                <Text style={{ fontVariant: ['tabular-nums'], color: (totals.get(item.id) ?? 0) < 0 ? color.danger : color.text }}>{totals.get(item.id) ?? 0}</Text>
              </Row>
            ))}
            {gifts.length === 0 && <Muted>{catalog ? 'No Gifts match.' : 'No Gifts yet. Sync on the office Wi-Fi to download them.'}</Muted>}
            {gifts.length > MAX_LIST && <Muted>Type more of the name to see the rest.</Muted>}
          </View>
        </>
      )}

      <Button kind="secondary" title="My entries" onPress={() => router.push('/history')} />
      {user && <Text style={{ textAlign: 'center', color: color.muted }}>Signed in as {user.displayName}</Text>}
    </Screen>
  );
}
