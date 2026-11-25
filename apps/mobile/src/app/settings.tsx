import { Alert, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { chooseEntryType, forgetDevice, logout, syncNow, useStore } from '@/lib/store';
import { EntryTypePicker } from '@/components/EntryTypePicker';
import { SyncBar } from '@/components/SyncBar';
import { ago, Button, Card, H, Muted, Screen } from '@/ui';

export default function SettingsScreen() {
  const router = useRouter();
  const entryType = useStore((s) => s.prefs.entryType);
  const user = useStore((s) => s.user);
  const servers = useStore((s) => s.servers);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const pendingMine = useStore((s) => s.outbox.filter((o) => o.userId === s.user?.id).length);
  const pendingAll = useStore((s) => s.outbox.length);

  return (
    <Screen>
      <SyncBar />
      <Card>
        <H>What are you doing?</H>
        <EntryTypePicker value={entryType} onChange={async (t) => {
            await chooseEntryType(t);
            if (router.canGoBack()) router.back();
            else router.replace('/');
          }} />
      </Card>
      <Card>
        <H>{user?.displayName}</H>
        <Muted>
          {user?.username} · {user?.role === 'admin' ? 'Admin' : 'Staff'}
        </Muted>
        <Button kind="secondary" title="Sync now" onPress={() => void syncNow()} />
        <Button
          kind="secondary"
          title="Sign out"
          onPress={() =>
            Alert.alert(
              'Sign out?',
              pendingMine ? `${pendingMine} entries have not synced yet. They stay on this phone and sync when you sign in again.` : 'Someone else can then sign in on this phone.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Sign out', onPress: () => void logout() },
              ],
            )
          }
        />
      </Card>
      <Card>
        <H>Server</H>
        {servers.map((s, i) => (
          <Text key={s}>
            {s}
            {i === 0 ? '  (last used)' : ''}
          </Text>
        ))}
        <Muted>Last sync {ago(lastSyncAt)}.</Muted>
        <Button
          kind="danger"
          title="Disconnect this phone"
          onPress={() =>
            Alert.alert('Disconnect this phone?', `${pendingAll ? `${pendingAll} unsynced entries will be DELETED. ` : ''}You will need a new pairing code from an Admin.`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Disconnect', style: 'destructive', onPress: () => void forgetDevice() },
            ])
          }
        />
      </Card>
    </Screen>
  );
}
