import { router } from 'expo-router';
import { useT } from '../../i18n/useT';
import { tokens as t } from '../../theme/tokens';
import { useErrands } from '../../features/errands/hooks';
import { Screen } from '../../components/Screen';
import { LiveCard } from '../../components/LiveCard';
import { Body } from '../../components/ui';

export default function Active() {
  const T = useT();
  const live = useErrands('live', 'runner');
  const mine = (live.data ?? []).filter((e) => e.status !== 'offered');
  return (
    <Screen title={T('active.title')} onRefresh={() => live.refetch()} refreshing={live.isRefetching}>
      {mine.length === 0 ? <Body color={t.textMuted}>{T('active.empty')}</Body> : null}
      {mine.map((e) => <LiveCard key={e.id} e={e} onPress={() => router.push(`/errand/${e.id}`)} />)}
    </Screen>
  );
}
