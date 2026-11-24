import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { resolveScan } from '@gifts/shared';
import { Scanner } from '@/components/Scanner';
import { getState } from '@/lib/store';

export default function ScanScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [paused, setPaused] = useState(false);

  const onScan = (data: string) => {
    const result = resolveScan(data, getState().catalog?.gifts ?? []);
    if (result.type === 'gift') {
      setPaused(true);
      router.replace({ pathname: '/entry', params: { giftId: result.gift.id } });
    } else if (result.type === 'unknown-barcode') {
      setPaused(true);
      router.replace({ pathname: '/link', params: { code: result.code } });
    } else {
      setPaused(true);
      Alert.alert('Gift not on this phone yet', 'This label is for a Gift this phone has not downloaded. Sync on the office Wi-Fi and try again.', [
        { text: 'OK', onPress: () => setPaused(false) },
      ]);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <Scanner onScan={onScan} paused={paused} hint="Point at a Gift Label or the barcode on the packaging" />
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        style={{ position: 'absolute', top: insets.top + 12, left: 16, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 }}
      >
        <Text style={{ color: '#fff', fontWeight: '600' }}>✕ Close</Text>
      </Pressable>
    </View>
  );
}
