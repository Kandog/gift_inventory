import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const color = {
  bg: '#f4f6f9',
  card: '#ffffff',
  text: '#1c2430',
  muted: '#6b7686',
  line: '#e1e5eb',
  accent: '#2f6fde',
  danger: '#c4372f',
  warn: '#b7791f',
  ok: '#2f8a4e',
};

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }} edges={['bottom', 'left', 'right']}>
      {scroll ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, padding: 16, gap: 12 }}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function H({ children }: { children: ReactNode }) {
  return <Text style={s.h}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={{ color: color.muted }}>{children}</Text>;
}

export function ErrorText({ error }: { error: string | null | undefined }) {
  return error ? <Text style={{ color: color.danger }}>{error}</Text> : null;
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  busy,
  big,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  big?: boolean;
}) {
  const bg = kind === 'primary' ? color.accent : color.card;
  const fg = kind === 'primary' ? '#fff' : kind === 'danger' ? color.danger : color.text;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [s.button, big && { paddingVertical: 18 }, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 }, kind !== 'primary' && s.outline]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: '600', fontSize: big ? 18 : 16 }}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      {children}
    </View>
  );
}

export function Input(props: TextInputProps) {
  return <TextInput placeholderTextColor={color.muted} {...props} style={[s.input, props.style]} />;
}

/** A row of mutually exclusive choices, e.g. the Movement kinds. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T | null; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={[s.chip, on && { backgroundColor: color.accent, borderColor: color.accent }]}
          >
            <Text style={{ color: on ? '#fff' : color.text, fontWeight: '600' }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Row({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [s.row, pressed && { backgroundColor: '#eef2f8' }]}>
      {children}
    </Pressable>
  );
}

export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const s = StyleSheet.create({
  card: { backgroundColor: color.card, borderRadius: 12, padding: 14, gap: 10, borderWidth: 1, borderColor: color.line },
  h: { fontSize: 18, fontWeight: '700', color: color.text },
  label: { fontWeight: '600', color: color.text },
  button: { borderRadius: 10, paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  outline: { borderWidth: 1, borderColor: color.line },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#cfd5dd', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16, color: color.text },
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, borderWidth: 1, borderColor: color.line, backgroundColor: color.card },
  row: { paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: color.line, flexDirection: 'row', alignItems: 'center', gap: 12 },
});
