import { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { Redirect, Stack, useRouter } from 'expo-router';
import { searchGifts } from '@gifts/shared';
import { SyncBar } from '@/components/SyncBar';
import { useStore } from '@/lib/store';
import { Button, color, Input, Muted, Row } from '@/ui';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
  const router = useRouter();
  const modeConfirmed = useStore((s) => s.modeConfirmed);
  const mode = useStore((s) => s.prefs.mode);
  const catalog = useStore((s) => s.catalog);
  const user = useStore((s) => s.user);
  const [query, setQuery] = useState('');

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

  if (!modeConfirmed || !mode) return <Redirect href="/mode" />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={['bottom', 'left', 'right']}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => router.push('/settings')} hitSlop={12} accessibilityLabel="Settings">
              <Text style={{ fontSize: 22 }}>⚙︎</Text>
            </Pressable>
          ),
        }}
      />
      <View style={{ padding: 16, gap: 12 }}>
        <SyncBar />
        <Pressable onPress={() => router.push('/mode')} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: color.muted }}>Mode:</Text>
          <Text style={{ fontWeight: '700', color: color.accent }}>{mode === 'count' ? 'Count (what is on the shelf)' : 'Movement (in / out)'}</Text>
          <Text style={{ color: color.muted }}>· change</Text>
        </Pressable>
        <Button big title="📷  Scan a Gift" onPress={() => router.push('/scan')} />
        <Input value={query} onChangeText={setQuery} placeholder="…or type a Gift name" autoCorrect={false} clearButtonMode="while-editing" />
      </View>
      <FlatList
        style={{ flex: 1, paddingHorizontal: 16 }}
        data={gifts}
        keyExtractor={(g) => g.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={<Muted>{catalog ? 'No Gifts match.' : 'No Gifts yet. Sync on the office Wi-Fi to download them.'}</Muted>}
        renderItem={({ item }) => (
          <Row onPress={() => router.push({ pathname: '/entry', params: { giftId: item.id } })}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '600' }}>{item.name}</Text>
              <Muted>{categoryName(item.categoryId) || ' '}</Muted>
            </View>
            <Text style={{ fontVariant: ['tabular-nums'], color: (totals.get(item.id) ?? 0) < 0 ? color.danger : color.text }}>{totals.get(item.id) ?? 0}</Text>
          </Row>
        )}
      />
      <View style={{ flexDirection: 'row', gap: 10, padding: 16 }}>
        <View style={{ flex: 1 }}>
          <Button kind="secondary" title="My entries" onPress={() => router.push('/history')} />
        </View>
      </View>
      {user && <Text style={{ textAlign: 'center', color: color.muted, paddingBottom: 8 }}>Signed in as {user.displayName}</Text>}
    </SafeAreaView>
  );
}
