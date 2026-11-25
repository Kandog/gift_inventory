import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { enableLegacyHeaderAppearance, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { init, useStore } from '@/lib/store';

// On iOS 26+ the header is transparent by default and screens draw underneath it, which hid
// (and blocked taps on) the sync bar and the entry type buttons at the top of the home screen.
// Keep the opaque header with content below it, as on Android and older iOS.
enableLegacyHeaderAppearance();

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
          <Stack.Screen name="start" options={{ title: 'Gift Inventory' }} />
          <Stack.Screen name="link" options={{ title: 'Unknown barcode' }} />
          <Stack.Screen name="history" options={{ title: 'My entries' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        </Stack.Protected>
      </Stack>
    </SafeAreaProvider>
  );
}
