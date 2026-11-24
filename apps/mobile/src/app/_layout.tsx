import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { init, useStore } from '@/lib/store';

export default function RootLayout() {
  const phase = useStore((s) => s.phase);
  useEffect(() => {
    void init();
  }, []);

  if (phase === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerBackTitle: 'Back' }}>
        <Stack.Protected guard={phase === 'unpaired'}>
          <Stack.Screen name="pair" options={{ title: 'Connect to server', headerShown: true }} />
        </Stack.Protected>
        <Stack.Protected guard={phase === 'signed-out'}>
          <Stack.Screen name="login" options={{ title: 'Sign in' }} />
        </Stack.Protected>
        <Stack.Protected guard={phase === 'ready'}>
          <Stack.Screen name="index" options={{ title: 'Gift Inventory' }} />
          <Stack.Screen name="mode" options={{ title: 'Entry Mode', presentation: 'modal' }} />
          <Stack.Screen name="scan" options={{ title: 'Scan', headerShown: false }} />
          <Stack.Screen name="entry" options={{ title: 'Record' }} />
          <Stack.Screen name="link" options={{ title: 'Unknown barcode' }} />
          <Stack.Screen name="history" options={{ title: 'My entries' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack.Protected>
      </Stack>
    </SafeAreaProvider>
  );
}
