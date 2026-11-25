import { Pressable, Text, View } from 'react-native';
import { ENTRY_TYPES, type EntryType } from '@/lib/store';
import { color, Muted } from '@/ui';

/** The five entry types as big buttons, with a one-line hint for the chosen one. */
export function EntryTypePicker({ value, onChange }: { value: EntryType | null; onChange: (t: EntryType) => void }) {
  const hint = ENTRY_TYPES.find((t) => t.value === value)?.hint;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {ENTRY_TYPES.map((t) => {
          const on = t.value === value;
          return (
            <Pressable
              key={t.value}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => onChange(t.value)}
              style={({ pressed }) => ({
                flexGrow: 1,
                minWidth: '30%',
                alignItems: 'center',
                paddingVertical: 14,
                borderRadius: 12,
                borderWidth: 2,
                borderColor: on ? color.accent : color.line,
                backgroundColor: on ? color.accent : color.card,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Text style={{ fontSize: 16, fontWeight: '700', color: on ? '#fff' : color.text }}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {hint && <Muted>{hint}</Muted>}
    </View>
  );
}
