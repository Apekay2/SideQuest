import { router } from 'expo-router';
import { Text } from 'react-native';
import { tokens as t } from '../../theme/tokens';
import { useT } from '../../i18n/useT';
import { kes } from '../../lib/money';
import { useSession } from '../../lib/session';
import { useErrands } from '../../features/errands/hooks';
import { Screen } from '../../components/Screen';
import { LiveCard } from '../../components/LiveCard';
import { PostFab } from '../../components/AdaptiveTabBar';
import { NotifyIntro } from '../../components/NotifyIntro';
import { Eyebrow, SunkRow, Body, Card, Heading, PrimaryButton } from '../../components/ui';

export default function Home() {
  const T = useT();
  const tier = useSession((s) => s.account?.verification_tier ?? 0);
  const live = useErrands('live', 'requester');
  const open = useErrands('open', 'requester');
  const done = useErrands('done', 'requester');
  const running = [...(live.data ?? []), ...(open.data ?? [])];
  const again = (done.data ?? []).filter((e) => e.status === 'settled').slice(0, 4);

  return (
    <Screen title={T('home.title')} onRefresh={() => { live.refetch(); open.refetch(); done.refetch(); }} refreshing={live.isRefetching}
      overlay={<PostFab onPress={() => router.push('/post')} />}>
      {tier < 1 ? (
        <Card tint>
          <Heading color={t.accentDeep}>{T('home.browse_only')}</Heading>
          <Body style={{ marginTop: 6 }}>{T('home.verify_body')}</Body>
          <PrimaryButton style={{ marginTop: 14 }} label={T('home.verify_cta')} onPress={() => router.push('/kyc')} />
        </Card>
      ) : null}
      {tier >= 1 ? <NotifyIntro role="requester" /> : null}
      <Eyebrow>{T('home.live')}</Eyebrow>
      {running.length === 0 ? <Body color={t.textMuted}>{T('home.empty')}</Body> : null}
      {running.map((e) => <LiveCard key={e.id} e={e} onPress={() => router.push(`/errand/${e.id}`)} />)}
      {again.length > 0 ? <Eyebrow style={{ marginTop: 6 }}>{T('home.post_again')}</Eyebrow> : null}
      {again.map((e) => (
        <SunkRow key={e.id} accessibilityLabel={`${T('home.post_again')}: ${e.title}`} onPress={() => router.push({ pathname: '/post', params: { from: e.id } })}>
          <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.text, flex: 1 }}>{e.title}</Text>
          <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.textMuted }}>{kes(e.spent_cents + (e.agreed_fee_cents ?? 0), T.locale)}</Text>
        </SunkRow>
      ))}
    </Screen>
  );
}
