import { Pressable, Text } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { SyncBar } from '@/components/SyncBar';
import { chooseEntryType, ENTRY_TYPES, useStore, type EntryType } from '@/lib/store';
import { color, H, Muted, Screen } from '@/ui';

/** The first page after sign-in: choose what you are recording, then go to the entry screen. */
export default function StartScreen() {
  const router = useRouter();
  const current = useStore((s) => (s.typeConfirmed ? s.prefs.entryType : null));
  const user = useStore((s) => s.user);

  const choose = async (t: EntryType) => {
    await chooseEntryType(t);
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

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
      <H>What are you doing?</H>
      <Muted>You can change this any time.</Muted>
      {ENTRY_TYPES.map((t) => (
        <Pressable
          key={t.value}
          accessibilityRole="button"
          onPress={() => void choose(t.value)}
          style={({ pressed }) => ({
            backgroundColor: color.card,
            borderRadius: 14,
            padding: 18,
            gap: 4,
            borderWidth: 2,
            borderColor: current === t.value ? color.accent : color.line,
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Text style={{ fontSize: 20, fontWeight: '700', color: color.text }}>{t.label}</Text>
          <Text style={{ color: color.muted, fontSize: 15 }}>{t.hint}</Text>
        </Pressable>
      ))}
      {user && <Text style={{ textAlign: 'center', color: color.muted }}>Signed in as {user.displayName}</Text>}
    </Screen>
  );
}
