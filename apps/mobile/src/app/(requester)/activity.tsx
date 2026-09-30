import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { tokens as t } from '../../theme/tokens';
import { useT, type Key } from '../../i18n/useT';
import { kes } from '../../lib/money';
import { useErrands } from '../../features/errands/hooks';
import { Screen } from '../../components/Screen';
import { PostFab } from '../../components/AdaptiveTabBar';
import { SunkRow, Body } from '../../components/ui';

export default function Activity() {
  const T = useT();
  const all = useErrands('all', 'requester');
  return (
    <Screen title={T('activity.title')} onRefresh={() => all.refetch()} refreshing={all.isRefetching}
      overlay={<PostFab onPress={() => router.push('/post')} />}>
      {all.data?.length === 0 ? <Body color={t.textMuted}>{T('activity.empty')}</Body> : null}
      {(all.data ?? []).map((e) => (
        <SunkRow key={e.id} onPress={() => router.push(`/errand/${e.id}`)} accessibilityLabel={`${e.title}, ${T(`status.${e.status}` as Key)}`}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.text }}>{e.title}</Text>
            <Text style={{ fontFamily: t.fontBody, fontSize: t.size.meta, color: t.textMuted, marginTop: 2 }}>{T(`status.${e.status}` as Key)}</Text>
          </View>
          <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.textMuted }}>{kes(e.spend_cap_cents, T.locale)}</Text>
        </SunkRow>
      ))}
    </Screen>
  );
}
