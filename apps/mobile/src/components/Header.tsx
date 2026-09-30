// Large title header. iOS: 30pt Caprasimo title, 36pt avatar, 20pt gutter under the status bar.
// Android: M3 large top app bar, 28dp title, 40dp avatar, 16dp gutter, 48dp row.

import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { tokens as t } from '../theme/tokens';
import { metrics, headerStyle, pick, isAndroid } from '../platform/adaptive';
import { Heading, Meta } from './ui';
import { BackArrow, BackChevron } from './icons';
import { useT } from '../i18n/useT';
import { useSession } from '../lib/session';

export function LargeHeader({ title, back, right }: { title: string; back?: boolean; right?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const T = useT();
  const name = useSession((s) => s.account?.display_name ?? '');
  const isRunner = useSession((s) => s.account?.role === 'runner');
  const pad = pick({ ios: { top: insets.top + 8, bottom: 8 }, android: { top: insets.top + 16, bottom: 8 } });
  return (
    <View style={{ paddingTop: pad.top, paddingBottom: pad.bottom, paddingHorizontal: metrics.gutter }}>
      {back ? (
        <Pressable accessibilityRole="button" accessibilityLabel={T('common.back')} onPress={() => router.back()}
          style={{ minHeight: metrics.hitFloor, flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start' }}>
          {isAndroid ? <BackArrow color={t.text} /> : <BackChevron color={t.accentDeep} />}
          {headerStyle.backLabel ? <Meta color={t.accentDeep} style={{ fontSize: 16 }}>{T('common.back')}</Meta> : null}
        </Pressable>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: pick({ ios: 36, android: 48 }) }}>
        <Heading size={metrics.titleSize} accessibilityRole="header">{title}</Heading>
        {right ?? (
          <Pressable accessibilityRole="button" accessibilityLabel={T('tab.profile')} onPress={() => router.push(isRunner ? '/me' : '/profile')}
            hitSlop={(metrics.hitFloor - metrics.avatar) / 2}
            style={{ width: metrics.avatar, height: metrics.avatar, borderRadius: 999, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, alignItems: 'center', justifyContent: 'center' }}>
            <Meta color={t.textMuted}>{name.slice(0, 1)}</Meta>
          </Pressable>
        )}
      </View>
    </View>
  );
}
