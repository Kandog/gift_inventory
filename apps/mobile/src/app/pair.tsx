import { useState } from 'react';
import { Platform, View } from 'react-native';
import { Scanner } from '@/components/Scanner';
import { pair } from '@/lib/store';
import { Button, Card, ErrorText, Field, H, Input, Muted, Screen } from '@/ui';

export default function PairScreen() {
  const [manual, setManual] = useState(false);
  const [server, setServer] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState(Platform.OS === 'ios' ? 'iPhone' : 'Android phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async (input: Parameters<typeof pair>[0]) => {
    setBusy(true);
    setError(null);
    try {
      await pair(input, name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!manual) {
    return (
      <View style={{ flex: 1 }}>
        <Scanner qrOnly paused={busy} onScan={(qr) => go({ qr })} hint="On the PC dashboard open Devices → Pair a phone, then point the camera at the code." />
        <View style={{ padding: 16, gap: 10, backgroundColor: '#fff' }}>
          <Field label="Name for this phone">
            <Input value={name} onChangeText={setName} placeholder="e.g. Sam's iPhone" />
          </Field>
          <ErrorText error={error} />
          <Button kind="secondary" title="Type the code instead" onPress={() => setManual(true)} />
        </View>
      </View>
    );
  }

  return (
    <Screen>
      <Card>
        <H>Connect by hand</H>
        <Muted>The PC dashboard shows these under Devices → Pair a phone. The phone must be on the office Wi-Fi.</Muted>
        <Field label="Server address">
          <Input value={server} onChangeText={setServer} placeholder="http://192.168.1.37:8080" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        </Field>
        <Field label="Pairing code">
          <Input value={code} onChangeText={setCode} placeholder="e.g. Y7FUT74C" autoCapitalize="characters" autoCorrect={false} />
        </Field>
        <Field label="Name for this phone">
          <Input value={name} onChangeText={setName} />
        </Field>
        <ErrorText error={error} />
        <Button title="Connect" busy={busy} disabled={!server || !code} onPress={() => go({ server, code })} />
        <Button kind="secondary" title="Scan instead" onPress={() => setManual(false)} />
      </Card>
    </Screen>
  );
}
