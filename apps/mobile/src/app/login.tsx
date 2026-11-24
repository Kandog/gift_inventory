import { useState } from 'react';
import { Alert } from 'react-native';
import { dismissNotice, forgetDevice, login, useStore } from '@/lib/store';
import { Button, Card, ErrorText, Field, H, Input, Muted, Screen } from '@/ui';

export default function LoginScreen() {
  const notice = useStore((s) => s.notice);
  const lastUser = useStore((s) => s.user);
  const pending = useStore((s) => s.outbox.length);
  const [username, setUsername] = useState(lastUser?.username ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      dismissNotice();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      {notice && (
        <Card>
          <Muted>{notice}</Muted>
        </Card>
      )}
      <Card>
        <H>Sign in</H>
        <Field label="Username">
          <Input value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} textContentType="username" />
        </Field>
        <Field label="Password">
          <Input value={password} onChangeText={setPassword} secureTextEntry textContentType="password" onSubmitEditing={submit} />
        </Field>
        <ErrorText error={error} />
        <Button title="Sign in" busy={busy} disabled={!username || !password} onPress={submit} />
        <Muted>You stay signed in on this phone until you sign out.</Muted>
      </Card>
      {pending > 0 && (
        <Muted>
          {pending} unsynced entr{pending === 1 ? 'y is' : 'ies are'} saved on this phone. They sync when the person who recorded them signs in.
        </Muted>
      )}
      <Button
        kind="secondary"
        title="Connect to a different server"
        onPress={() =>
          Alert.alert('Disconnect this phone?', pending ? `${pending} unsynced entries will be deleted.` : 'You will need a new pairing code from an Admin.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Disconnect', style: 'destructive', onPress: () => void forgetDevice() },
          ])
        }
      />
    </Screen>
  );
}

