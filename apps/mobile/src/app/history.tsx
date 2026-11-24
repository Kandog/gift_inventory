import { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { canVoidNow, clearProblems, useStore, voidEntry, type HistoryItem } from '@/lib/store';
import { Button, Card, color, H, Input, Muted, Screen } from '@/ui';

const KIND: Record<string, string> = { count: 'Count', receive: 'Receive', issue: 'Issue', transfer: 'Transfer', writeoff: 'Write-off' };
const STATUS: Record<HistoryItem['status'], { label: string; color: string }> = {
  pending: { label: 'Waiting to sync', color: color.warn },
  synced: { label: 'Synced', color: color.ok },
  rejected: { label: 'Refused by server', color: color.danger },
  cancelled: { label: 'Cancelled', color: color.muted },
  'void-pending': { label: 'Void waiting to sync', color: color.warn },
  voided: { label: 'Voided', color: color.muted },
};

export default function HistoryScreen() {
  const history = useStore((s) => s.history);
  const problems = useStore((s) => s.problems);
  const catalog = useStore((s) => s.catalog);
  const userId = useStore((s) => s.user?.id);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [, tick] = useState(0);

  // Re-render every 30 s so the 10-minute Void window closes on screen.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const name = (id: string | null | undefined, list: { id: string; name: string }[] | undefined) => list?.find((x) => x.id === id)?.name ?? '?';
  const mine = history.filter((h) => h.entry.userId === userId);

  const doVoid = async (id: string) => {
    try {
      await voidEntry(id, reason.trim());
      setVoiding(null);
      setReason('');
    } catch (e) {
      Alert.alert('Cannot void', (e as Error).message);
    }
  };

  return (
    <Screen>
      {problems.length > 0 && (
        <Card style={{ borderColor: color.danger }}>
          <H>Refused by the server</H>
          <Muted>These were not recorded. Fix them on the dashboard or record them again.</Muted>
          {problems.map((p) => (
            <View key={p.id}>
              <Text style={{ fontWeight: '600' }}>{p.what}</Text>
              <Text style={{ color: color.danger }}>{p.reason}</Text>
            </View>
          ))}
          <Button kind="secondary" title="Clear this list" onPress={() => void clearProblems()} />
        </Card>
      )}
      <Muted>Your entries on this phone, newest first. You can Void your own entry for 10 minutes after making it; after that, ask an Admin.</Muted>
      {mine.length === 0 && <Muted>Nothing recorded yet.</Muted>}
      {mine.map((h) => {
        const e = h.entry;
        const st = STATUS[h.status];
        const struck = h.status === 'voided' || h.status === 'cancelled';
        return (
          <Card key={e.id}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontWeight: '700', textDecorationLine: struck ? 'line-through' : 'none' }}>
                {KIND[e.kind]} · {e.kind === 'count' ? '=' : e.kind === 'receive' ? '+' : e.kind === 'transfer' ? '⇄' : '−'}
                {e.quantity} {name(e.giftId, catalog?.gifts)}
              </Text>
            </View>
            <Muted>
              {name(e.locationId, catalog?.locations)}
              {e.toLocationId ? ` → ${name(e.toLocationId, catalog?.locations)}` : ''}
              {e.eventId ? ` · ${name(e.eventId, catalog?.events) === '?' ? 'new Event' : name(e.eventId, catalog?.events)}` : ''} · {new Date(e.occurredAt).toLocaleString()}
            </Muted>
            <Text style={{ color: st.color }}>
              {st.label}
              {h.reason ? `: ${h.reason}` : ''}
            </Text>
            {canVoidNow(h) &&
              (voiding === e.id ? (
                <View style={{ gap: 8 }}>
                  <Input value={reason} onChangeText={setReason} placeholder="Why? e.g. typed 300 instead of 30" autoFocus />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Button kind="secondary" title="Keep" onPress={() => setVoiding(null)} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button kind="danger" title="Void it" disabled={!reason.trim()} onPress={() => doVoid(e.id)} />
                    </View>
                  </View>
                </View>
              ) : (
                <Button kind="danger" title="Void (mistake)" onPress={() => setVoiding(e.id)} />
              ))}
          </Card>
        );
      })}
    </Screen>
  );
}
