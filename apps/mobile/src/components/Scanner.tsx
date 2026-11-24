import { useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import { Button, color } from '@/ui';

const TYPES: BarcodeType[] = ['qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128'];

/**
 * Full-area camera that reports each distinct code once. `paused` stops reporting while the
 * caller handles a result (the camera keeps firing for every frame otherwise).
 */
export function Scanner({ onScan, paused, qrOnly, hint }: { onScan: (data: string) => void; paused?: boolean; qrOnly?: boolean; hint?: string }) {
  const [permission, requestPermission] = useCameraPermissions();
  const last = useRef<{ data: string; at: number } | null>(null);

  if (!permission) return <View style={{ flex: 1, backgroundColor: '#000' }} />;
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={{ textAlign: 'center', marginBottom: 12 }}>The camera is needed to scan codes.</Text>
        {permission.canAskAgain ? (
          <Button title="Allow camera" onPress={requestPermission} />
        ) : (
          <Text style={{ color: color.muted, textAlign: 'center' }}>Camera access is turned off. Enable it for Gift Inventory in the phone's Settings.</Text>
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: qrOnly ? ['qr'] : TYPES }}
        onBarcodeScanned={
          paused
            ? undefined
            : ({ data }) => {
                const t = Date.now();
                if (last.current && last.current.data === data && t - last.current.at < 2500) return;
                last.current = { data, at: t };
                onScan(data);
              }
        }
      />
      <View style={styles.frame} pointerEvents="none" />
      {hint && (
        <View style={styles.hint} pointerEvents="none">
          <Text style={{ color: '#fff', textAlign: 'center' }}>{hint}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  frame: { position: 'absolute', top: '28%', left: '12%', right: '12%', height: '30%', borderWidth: 3, borderColor: 'rgba(255,255,255,0.85)', borderRadius: 16 },
  hint: { position: 'absolute', bottom: 40, left: 20, right: 20, backgroundColor: 'rgba(0,0,0,0.55)', padding: 12, borderRadius: 10 },
});
