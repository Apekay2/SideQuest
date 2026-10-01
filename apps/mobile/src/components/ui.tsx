// apps/mobile/src/components/ui.tsx
// The shared vocabulary of the Organic system: text roles, surfaces, rows, buttons. Identical
// on both platforms except where adaptive.ts says otherwise (button height, press physics).

import type { ReactNode } from 'react';
import { Pressable, Text, View, ActivityIndicator, TextInput, type TextProps, type ViewStyle, type StyleProp, type TextInputProps } from 'react-native';
import { tokens as t } from '../theme/tokens';
import { metrics, pick, isAndroid } from '../platform/adaptive';

type Children = { children?: ReactNode };

export const Eyebrow = ({ children, style }: Children & { style?: TextProps['style'] }) => (
  <Text style={[{ fontFamily: t.fontBodySemi, fontSize: t.size.eyebrow, letterSpacing: 1.3, textTransform: 'uppercase', color: t.textFaint }, style]}>{children}</Text>
);
export const Heading = ({ children, size = t.size.title, color = t.text, style, ...rest }: Children & TextProps & { size?: number; color?: string }) => (
  <Text {...rest} style={[{ fontFamily: t.fontHeading, fontSize: size, color }, style]}>{children}</Text>
);
export const Body = ({ children, color = t.textBody, size = t.size.body, style, ...rest }: Children & TextProps & { color?: string; size?: number }) => (
  <Text {...rest} style={[{ fontFamily: t.fontBody, fontSize: size, color, lineHeight: Math.round(size * 1.55) }, style]}>{children}</Text>
);
export const Meta = ({ children, color = t.textMuted, style, ...rest }: Children & TextProps & { color?: string }) => (
  <Text {...rest} style={[{ fontFamily: t.fontBody, fontSize: t.size.meta, color }, style]}>{children}</Text>
);

/** A raised card: surface, hairline border, radius 28. */
export const Card = ({ children, style, tint }: Children & { style?: StyleProp<ViewStyle>; tint?: boolean }) => (
  <View style={[{
    backgroundColor: tint ? t.accentTint : t.surface, borderWidth: 1, borderColor: tint ? t.accentEdge : t.border,
    borderRadius: t.radius.card, padding: 16,
  }, style]}>{children}</View>
);

/** An inset row on surfaceSunk, radius 20: items, repeat errands, list entries. */
export function SunkRow({ children, onPress, style, accessibilityLabel }: Children & { onPress?: () => void; style?: StyleProp<ViewStyle>; accessibilityLabel?: string }) {
  const base: ViewStyle = { backgroundColor: t.surfaceSunk, borderRadius: t.radius.sunk, paddingVertical: 13, paddingHorizontal: 15, minHeight: metrics.tap, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress}
      android_ripple={isAndroid ? { color: t.borderSunk } : undefined}
      style={({ pressed }) => [base, { opacity: !isAndroid && pressed ? 0.7 : 1, overflow: 'hidden' }, style]}>
      {children}
    </Pressable>
  );
}

/**
 * Primary pill. accentDeep fill, accentTint Caprasimo label; iOS dims to `accent` on press,
 * Android ripples `accent` from the touch point (§11.3). Never silently disabled: pass
 * `disabled` only alongside visible text that says why.
 */
export function PrimaryButton({ label, onPress, disabled, loading, loadingLabel, accessibilityLabel, style }: {
  label: string; onPress: () => void; disabled?: boolean; loading?: boolean; loadingLabel?: string;
  accessibilityLabel?: string; style?: StyleProp<ViewStyle>;
}) {
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(off), busy: Boolean(loading) }}
      disabled={off}
      onPress={onPress}
      android_ripple={isAndroid && !off ? { color: t.accent, borderless: false } : undefined}
      style={({ pressed }) => [{
        minHeight: metrics.primaryButtonHeight, borderRadius: t.radius.pill, overflow: 'hidden',
        alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20,
        backgroundColor: disabled && !loading ? t.border : !isAndroid && pressed ? t.accent : t.accentDeep,
        opacity: loading ? 0.8 : 1,
      }, style]}
    >
      {loading ? (
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <ActivityIndicator color={t.accentTint} />
          <Text style={{ fontFamily: t.fontHeading, fontSize: t.size.button, color: t.accentTint }}>{loadingLabel ?? label}</Text>
        </View>
      ) : (
        <Text style={{ fontFamily: t.fontHeading, fontSize: t.size.button, color: disabled ? t.textMuted : t.accentTint }}>{label}</Text>
      )}
    </Pressable>
  );
}

/** Outlined secondary pill: Substitute, Decline, Withdraw. */
export function SecondaryButton({ label, onPress, disabled, style, accessibilityLabel }: {
  label: string; onPress: () => void; disabled?: boolean; style?: StyleProp<ViewStyle>; accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      android_ripple={isAndroid ? { color: t.surfaceSunk } : undefined}
      style={({ pressed }) => [{
        flex: 1, minHeight: metrics.secondaryButtonHeight, borderRadius: t.radius.pill, borderWidth: 1, borderColor: t.border,
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden', paddingHorizontal: 14,
        backgroundColor: !isAndroid && pressed ? t.surfaceSunk : 'transparent', opacity: disabled ? 0.45 : 1,
      }, style]}
    >
      <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.textMuted }}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, style, ...rest }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Eyebrow>{label}</Eyebrow>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.textFaint}
        {...rest}
        style={[{
          backgroundColor: t.surfaceSunk, borderRadius: t.radius.sunk, paddingHorizontal: 15, minHeight: metrics.hitFloor,
          fontFamily: t.fontBody, fontSize: 15, color: t.text, borderWidth: 1, borderColor: t.borderSunk,
        }, style]}
      />
    </View>
  );
}

/** Choice chip: selected is accentDeep on accentTint with a check — never colour alone. */
export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
      style={{ minHeight: metrics.hitFloor, paddingHorizontal: 16, borderRadius: t.radius.pill, borderWidth: 1,
        borderColor: selected ? t.accentEdge : t.border, backgroundColor: selected ? t.accentTint : t.surface,
        alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 }}>
      {selected ? <Text style={{ color: t.accentDeep, fontFamily: t.fontBodyBold }}>✓</Text> : null}
      <Text style={{ fontFamily: selected ? t.fontBodySemi : t.fontBody, fontSize: t.size.body, color: selected ? t.accentDeep : t.textBody }}>{label}</Text>
    </Pressable>
  );
}

/** An exception or error state: terracotta tint with an icon and a sentence (§11.2). */
export function Notice({ children, tone = 'warn' }: Children & { tone?: 'warn' | 'ok' }) {
  const warn = tone === 'warn';
  return (
    <View style={{ backgroundColor: warn ? t.accentTint : t.surfaceSunk, borderWidth: 1, borderColor: warn ? t.accentEdge : t.borderSunk,
      borderRadius: t.radius.sunk, padding: 13, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: warn ? t.accentDeep : t.accent2, fontFamily: t.fontBodyBold, fontSize: 14 }}>{warn ? '!' : '✓'}</Text>
      <Text style={{ flex: 1, fontFamily: t.fontBody, fontSize: 13, lineHeight: 19, color: warn ? t.accentDeep : t.textBody }}>{children}</Text>
    </View>
  );
}

export const gutter = metrics.gutter;
export const contentPad = pick({ ios: { paddingTop: 12 }, android: { paddingTop: 8 } });
