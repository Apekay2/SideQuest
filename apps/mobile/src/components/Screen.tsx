import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { tokens as t } from '../theme/tokens';
import { metrics, pick } from '../platform/adaptive';
import { LargeHeader } from './Header';

/** A tab screen: large header, then content on the gutter with 12 between cards. */
export function Screen({ title, children, back, right, onRefresh, refreshing, overlay }: {
  title: string; children: ReactNode; back?: boolean; right?: ReactNode;
  onRefresh?: () => void; refreshing?: boolean; overlay?: ReactNode;
}) {
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <LargeHeader title={title} back={back} right={right} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: metrics.gutter, paddingTop: pick({ ios: 12, android: 8 }), paddingBottom: 120, gap: 12 }}
        refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={t.accent} colors={[t.accentDeep]} /> : undefined}
      >
        {children}
      </ScrollView>
      {overlay}
    </View>
  );
}
