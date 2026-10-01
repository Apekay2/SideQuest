// apps/mobile/src/components/AdaptiveTabBar.tsx
// Section 1 of the parity design. The tab bar is where the platforms genuinely part company:
//   iOS      five tabs, Post among them; 49pt bar over the home indicator; translucent;
//            the active icon and label tinted accentDeep, 10px labels.
//   Android  four tabs; Post promoted to a FAB bottom-right; 80dp bar on surface; the M3
//            64×32 pill in accentEdge behind the active icon, 12px labels.
// Which tabs exist on each is decided in adaptive.ts (requesterNav), not here.

import { Pressable, Text, View } from 'react-native';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tokens as t } from '../theme/tokens';
import { metrics, tabBarStyle, haptic, requesterNav, fab as fabMetrics } from '../platform/adaptive';
import { HomeIcon, PlusIcon, ActivityIcon, WalletIcon, ProfileIcon, FeedIcon, ActiveIcon } from './icons';
import { useT, type Key } from '../i18n/useT';

const ICONS: Record<string, (p: { color: string }) => React.JSX.Element> = {
  home: HomeIcon, post: PlusIcon, activity: ActivityIcon, wallet: WalletIcon, profile: ProfileIcon,
  feed: FeedIcon, active: ActiveIcon, earnings: WalletIcon, me: ProfileIcon,
};

export function AdaptiveTabBar({ state, navigation, visible }: BottomTabBarProps & { visible: readonly string[] }) {
  const T = useT();
  const insets = useSafeAreaInsets();
  const routes = state.routes.filter((r) => visible.includes(r.name));
  const active = state.routes[state.index]?.name;

  const ios = tabBarStyle.kind === 'ios';
  return (
    <View
      accessibilityRole="tablist"
      style={ios ? {
        borderTopWidth: 1, borderTopColor: t.border, backgroundColor: tabBarStyle.background,
        paddingTop: tabBarStyle.paddingTop, paddingHorizontal: 4, height: metrics.tabBarHeight + insets.bottom,
        flexDirection: 'row', alignItems: 'flex-start',
      } : {
        backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.border,
        height: metrics.tabBarHeight + insets.bottom, paddingBottom: insets.bottom, paddingHorizontal: 4,
        flexDirection: 'row', alignItems: 'center',
      }}
    >
      {routes.map((r) => {
        const focused = r.name === active;
        const Icon = ICONS[r.name] ?? HomeIcon;
        const label = T(`tab.${r.name === 'me' ? 'profile' : r.name}` as Key);
        const color = focused ? t.accentDeep : ios ? t.textFaint : t.textMuted;
        return (
          <Pressable
            key={r.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={label}
            onPress={() => {
              const e = navigation.emit({ type: 'tabPress', target: r.key, canPreventDefault: true });
              if (!focused && !e.defaultPrevented) {
                haptic.select();
                navigation.navigate(r.name);
              }
            }}
            style={{ flex: 1, alignItems: 'center', gap: 4, minHeight: metrics.hitFloor, justifyContent: ios ? 'flex-start' : 'center' }}
          >
            {ios ? <Icon color={color} /> : (
              <View style={{
                width: 64, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                backgroundColor: focused ? t.accentEdge : 'transparent',
              }}>
                <Icon color={color} />
              </View>
            )}
            <Text style={{ fontSize: metrics.tabLabelSize, color, fontFamily: focused ? t.fontBodySemi : t.fontBody }}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Android's create action. Sits 16dp above the 80dp bar, right-aligned (parity design §1). */
export function PostFab({ onPress }: { onPress: () => void }) {
  const T = useT();
  const insets = useSafeAreaInsets();
  // Driven by the same table as the tab list, so the two can never disagree.
  if (requesterNav.createAs !== 'fab') return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={T('fab.post')}
      onPress={() => { haptic.select(); onPress(); }}
      android_ripple={{ color: t.accent, borderless: false }}
      style={{
        position: 'absolute', right: fabMetrics.right, bottom: metrics.tabBarHeight + insets.bottom + fabMetrics.bottomAboveBar,
        width: fabMetrics.size, height: fabMetrics.size, borderRadius: fabMetrics.radius, backgroundColor: t.accentDeep,
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden', elevation: 6,
        shadowColor: t.ink, shadowOpacity: 0.22, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
      }}
    >
      <PlusIcon color={t.accentTint} size={28} strokeWidth={2.1} />
    </Pressable>
  );
}
