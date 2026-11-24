import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { confirmMode, useStore, type EntryMode } from '@/lib/store';
import { color, H, Muted, Screen } from '@/ui';

const CHOICES: { mode: EntryMode; title: string; body: string }[] = [
  { mode: 'count', title: 'Count', body: 'I am counting what is on the shelf. The number I enter replaces the stock at that Location.' },
  { mode: 'movement', title: 'Movement', body: 'Gifts are coming in or going out: Receive, Issue at an Event, Transfer, or Write-off.' },
];

export default function ModeScreen() {
  const router = useRouter();
  const current = useStore((s) => s.prefs.mode);
  const choose = async (mode: EntryMode) => {
    await confirmMode(mode);
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  return (
    <Screen>
      <H>What are you doing?</H>
      <Muted>You can change this any time from the home screen.</Muted>
      {CHOICES.map((c) => (
        <Pressable
          key={c.mode}
          accessibilityRole="button"
          onPress={() => choose(c.mode)}
          style={({ pressed }) => ({
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 18,
            gap: 6,
            borderWidth: 2,
            borderColor: current === c.mode ? color.accent : '#e1e5eb',
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Text style={{ fontSize: 20, fontWeight: '700' }}>{c.title}</Text>
          <Text style={{ color: color.muted, fontSize: 15 }}>{c.body}</Text>
        </Pressable>
      ))}
    </Screen>
  );
}
