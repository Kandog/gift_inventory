import { useMemo, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { searchGifts } from '@gifts/shared';
import { createGiftOnline, linkBarcode, useStore } from '@/lib/store';
import { Button, Card, ErrorText, Field, H, Input, Muted, Row, Screen, Segmented } from '@/ui';

/** A scanned Barcode no Gift has yet: link it to an existing Gift, or (Admins, online) create a new Gift. */
export default function LinkScreen() {
  const router = useRouter();
  const { code = '' } = useLocalSearchParams<{ code: string }>();
  const catalog = useStore((s) => s.catalog);
  const user = useStore((s) => s.user);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = useMemo(() => (query ? searchGifts(query, catalog?.gifts ?? []).slice(0, 20) : []), [query, catalog]);

  const link = (giftId: string, giftName: string) =>
    Alert.alert('Link this barcode?', `From now on, scanning ${code} opens “${giftName}”.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Link',
        onPress: async () => {
          await linkBarcode(giftId, code);
          router.replace({ pathname: '/entry', params: { giftId } });
        },
      },
    ]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await createGiftOnline(name.trim(), categoryId, code);
      router.back();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Card>
        <H>Barcode {code}</H>
        <Muted>No Gift has this barcode yet. Which Gift is it?</Muted>
        <Input value={query} onChangeText={setQuery} placeholder="Search Gift name" autoFocus autoCorrect={false} />
        <View>
          {matches.map((g) => (
            <Row key={g.id} onPress={() => link(g.id, g.name)}>
              <Text style={{ fontSize: 16 }}>{g.name}</Text>
            </Row>
          ))}
        </View>
      </Card>
      {user?.role === 'admin' &&
        (creating ? (
          <Card>
            <H>New Gift</H>
            <Field label="Name">
              <Input value={name} onChangeText={setName} placeholder="e.g. Blue logo pen" />
            </Field>
            <Field label="Category">
              <Segmented value={categoryId} options={(catalog?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))} onChange={setCategoryId} />
            </Field>
            <Muted>Needs the office Wi-Fi. Add the cost, Packs and photo later on the dashboard.</Muted>
            <ErrorText error={error} />
            <Button title="Create Gift" busy={busy} disabled={!name.trim()} onPress={create} />
          </Card>
        ) : (
          <Button kind="secondary" title="It's a new Gift (Admin)" onPress={() => setCreating(true)} />
        ))}
    </Screen>
  );
}
