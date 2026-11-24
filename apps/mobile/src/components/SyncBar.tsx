import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { syncNow, useStore } from '@/lib/store';
import { ago, color } from '@/ui';

/** Shows whether the phone is connected and how much is waiting to sync. */
export function SyncBar() {
  const syncing = useStore((s) => s.syncing);
  const online = useStore((s) => s.online);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const syncError = useStore((s) => s.syncError);
  const pending = useStore((s) => s.outbox.filter((o) => o.userId === s.user?.id).length);
  const problems = useStore((s) => s.problems.length);
  const router = useRouter();

  const bg = online === false ? '#fcf1dc' : syncError || problems ? '#fbe7e5' : '#e3f4e9';
  const text = syncing
    ? 'Syncing…'
    : online === false
      ? `Offline. Stock as of ${ago(lastSyncAt)}.`
      : syncError
        ? `Sync problem: ${syncError}`
        : `Synced ${ago(lastSyncAt)}`;

  return (
    <Pressable onPress={() => (problems ? router.push('/history') : void syncNow())} style={{ backgroundColor: bg, borderRadius: 10, padding: 10, gap: 2 }}>
      <Text style={{ fontWeight: '600' }}>{text}</Text>
      {pending > 0 && <Text>{pending} waiting to sync. They send automatically on the office Wi-Fi.</Text>}
      {problems > 0 && <Text style={{ color: color.danger }}>{problems} entr{problems === 1 ? 'y was' : 'ies were'} refused by the server. Tap to see.</Text>}
      {!syncing && <Text style={{ color: color.muted, fontSize: 12 }}>Tap to sync now</Text>}
    </Pressable>
  );
}
