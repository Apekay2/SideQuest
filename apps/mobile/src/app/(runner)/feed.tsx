// Open Qwests near the runner, banded by distance, never showing other bids. Bids are blind.

import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import * as Location from 'expo-location';
import type { FeedItem } from '@sidequest/contracts';
import { tokens as t } from '../../theme/tokens';
import { useT, type Key } from '../../i18n/useT';
import { kes, toMinor } from '../../lib/money';
import { ApiError, api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useFeed, useAction, useErrands } from '../../features/errands/hooks';
import { Screen } from '../../components/Screen';
import { LiveCard } from '../../components/LiveCard';
import { Card, Eyebrow, Field, Heading, Meta, Notice, PrimaryButton, SecondaryButton, Body } from '../../components/ui';

export default function Feed() {
  const T = useT();
  const tier = useSession((s) => s.account?.verification_tier ?? 0);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const offers = useErrands('live', 'runner');
  const feed = useFeed(pos);
  const [bidding, setBidding] = useState<FeedItem | null>(null);

  useEffect(() => {
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) return;
      const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
      // Idle presence, so requesters can find this runner on their map (06 §6.5).
      if (tier >= 3) api.post('/presence', { lat: p.coords.latitude, lng: p.coords.longitude, available: true }).catch(() => undefined);
    })();
  }, [tier]);

  const incoming = (offers.data ?? []).filter((e) => e.status === 'offered');

  return (
    <Screen title={T('feed.title')} onRefresh={() => { feed.refetch(); offers.refetch(); }} refreshing={feed.isRefetching}>
      {tier < 2 ? (
        <Card tint><Body color={t.accentDeep}>{T('home.verify_body')}</Body>
          <PrimaryButton style={{ marginTop: 12 }} label={T('home.verify_cta')} onPress={() => router.push('/kyc')} /></Card>
      ) : null}
      {incoming.map((e) => <LiveCard key={e.id} e={e} onPress={() => router.push(`/errand/${e.id}`)} />)}
      {bidding ? <BidCard item={bidding} onDone={() => setBidding(null)} /> : null}
      {feed.data?.length === 0 ? <Body color={t.textMuted}>{T('feed.empty')}</Body> : null}
      {(feed.data ?? []).map((f) => (
        <Card key={f.id} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
            <Heading style={{ flex: 1 }}>{f.title}</Heading>
            <Meta>{T(`feed.band.${f.distance_band}` as Key)}</Meta>
          </View>
          <Meta>{`${T(`post.kind.${f.kind}` as Key)} · ${T('feed.guide', { amount: kes(f.max_fee_cents, T.locale) })}${f.stall_count ? ` · ${T('feed.stalls', { n: f.stall_count })}` : ''}${f.bonus_cents ? ' · +50' : ''}`}</Meta>
          {f.my_bid_cents ? <Text style={{ fontFamily: t.fontBodySemi, color: t.accent2 }}>✓ {T('feed.your_bid', { amount: kes(f.my_bid_cents, T.locale) })}</Text> : null}
          {tier >= 2 ? <SecondaryButton style={{ flex: 0, marginTop: 6 }} label={T('feed.bid')} onPress={() => setBidding(f)} /> : null}
        </Card>
      ))}
    </Screen>
  );
}

function BidCard({ item, onDone }: { item: FeedItem; onDone: () => void }) {
  const T = useT();
  const bid = useAction<{ fee_cents: number; eta_minutes: number; note?: string }>(() => `/errands/${item.id}/bids`, [['feed']]);
  const [fee, setFee] = useState(String(item.max_fee_cents / 100));
  const [eta, setEta] = useState('45');
  const [note, setNote] = useState('');
  const minor = toMinor(fee);
  // The runner's half of the 12% fee, shown before they commit (06 §6.10).
  const keep = minor ? minor - Math.trunc(Math.round(minor * 0.12) / 2) : 0;
  return (
    <Card tint style={{ gap: 10 }}>
      <Eyebrow>{T('bid.title')}</Eyebrow>
      <Heading>{item.title}</Heading>
      <Field label={T('bid.fee')} value={fee} onChangeText={setFee} keyboardType="number-pad" />
      <Meta>{T('bid.keep', { amount: kes(keep, T.locale) })}</Meta>
      <Field label={T('bid.eta')} value={eta} onChangeText={setEta} keyboardType="number-pad" />
      <Field label={T('bid.note')} value={note} onChangeText={setNote} />
      <Meta>{T('bid.blind')}</Meta>
      {bid.error instanceof ApiError ? <Notice>{bid.error.message}</Notice> : null}
      <PrimaryButton label={T('feed.bid')} loading={bid.isPending} disabled={!minor || !Number(eta)}
        onPress={() => bid.mutate({ body: { fee_cents: minor!, eta_minutes: Number(eta), ...(note.trim() ? { note: note.trim() } : {}) } }, { onSuccess: onDone })} />
      <SecondaryButton style={{ flex: 0 }} label={T('common.cancel')} onPress={onDone} />
    </Card>
  );
}
