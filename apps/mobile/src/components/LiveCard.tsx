// The "Live now" card from the parity design §1 — identical on both platforms.
// One segment per stall: sage when done, terracotta while it waits on the requester, sand
// otherwise. The caption says it in words too: never colour alone.

import { Pressable, Text, View } from 'react-native';
import type { ErrandSummary } from '@sidequest/contracts';
import { tokens as t } from '../theme/tokens';
import { isAndroid } from '../platform/adaptive';
import { useT, type Key } from '../i18n/useT';

export function LiveCard({ e, onPress }: { e: ErrandSummary; onPress: () => void }) {
  const T = useT();
  const waiting = e.stall_states.some((s) => s === 'photographed');
  const current = e.stall_states.findIndex((s) => s !== 'approved' && s !== 'declined' && s !== 'skipped');
  const mins = e.eta_at ? Math.max(1, Math.round((new Date(e.eta_at).getTime() - Date.now()) / 60_000)) : null;
  const who = e.counterparty_name ?? '';
  const meta = e.stall_count > 0
    ? T('home.stall_of', { name: who, done: Math.min(current < 0 ? e.stall_count : current + 1, e.stall_count), total: e.stall_count })
        .replace(/^ · /, '')
    : who;
  return (
    <Pressable accessibilityRole="button" onPress={onPress}
      android_ripple={isAndroid ? { color: t.surfaceSunk } : undefined}
      style={({ pressed }) => ({ backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radius.card, padding: 16, overflow: 'hidden', opacity: !isAndroid && pressed ? 0.85 : 1 })}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: t.fontHeading, fontSize: t.size.title, color: t.text }}>{e.title}</Text>
          {meta ? <Text style={{ fontFamily: t.fontBody, fontSize: t.size.meta, color: t.textMuted, marginTop: 3 }}>{meta}</Text> : null}
        </View>
        {mins !== null ? (
          <View style={{ backgroundColor: t.surfaceSunk, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 11 }}>
            <Text style={{ fontFamily: t.fontBodySemi, fontSize: t.size.meta, color: t.textBody }}>{T('home.min', { n: mins })}</Text>
          </View>
        ) : null}
      </View>
      {e.stall_states.length > 0 ? (
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 14 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {e.stall_states.map((s, i) => (
            <View key={i} style={{ flex: 1, height: 6, borderRadius: 999,
              backgroundColor: s === 'approved' || s === 'declined' || s === 'skipped' ? t.accent2 : s === 'photographed' ? t.accent : t.track }} />
          ))}
        </View>
      ) : null}
      <Text style={{ fontFamily: t.fontBody, fontSize: t.size.meta, color: t.textFaint, marginTop: 10 }}>
        {waiting ? T('home.waiting_you') : T(`status.${e.status}` as Key)}
      </Text>
    </Pressable>
  );
}
