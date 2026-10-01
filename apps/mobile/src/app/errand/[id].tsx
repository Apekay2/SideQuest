// LiveErrand (05-ui-architecture §5.2–5.3): a full-screen modal for both roles. An errand in
// flight is a mode, not a place — the user cannot tab away from a decision by accident.

import { useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import { useQuery } from '@tanstack/react-query';
import type { ErrandDetail, HandoverToken } from '@sidequest/contracts';
import { tokens as t } from '../../theme/tokens';
import { metrics } from '../../platform/adaptive';
import { useT, type Key } from '../../i18n/useT';
import { kes } from '../../lib/money';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useLink } from '../../lib/useLink';
import { useErrand, useBids, useNearby, useAction } from '../../features/errands/hooks';
import { Screen } from '../../components/Screen';
import { Card, Eyebrow, Heading, Meta, Body, PrimaryButton, SecondaryButton, SunkRow, Notice } from '../../components/ui';
import { CheckIcon, AlertIcon, ClockIcon } from '../../components/icons';

const LIVE = ['awarded', 'en_route', 'shopping', 'awaiting_approval', 'handover'];

export default function LiveErrand() {
  const T = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useSession((s) => s.account);
  const q = useErrand(id);
  const e = q.data;
  const role = e ? (e.requester.id === me?.id ? 'requester' : 'runner') : null;
  const link = useLink(id, role, Boolean(e && LIVE.includes(e.status)));

  if (!e) return <Screen title={T('live.title')} back><Meta>{T('common.loading')}</Meta></Screen>;

  return (
    <Screen title={e.title} back onRefresh={() => q.refetch()} refreshing={q.isRefetching}>
      <Meta color={t.textMuted}>{T(`status.${e.status}` as Key)}</Meta>
      {role === 'requester' ? <RequesterView e={e} link={link} /> : <RunnerView e={e} />}
    </Screen>
  );
}

// ─────────────────────────────────────────── requester

function RequesterView({ e, link }: { e: ErrandDetail; link: ReturnType<typeof useLink> }) {
  const T = useT();
  const fund = useAction<{ rail: 'wallet' | 'mpesa_stk' }>(() => `/errands/${e.id}/fund`, [['errand', e.id], ['wallet']]);
  const cancel = useAction(() => `/errands/${e.id}/cancel`, [['errand', e.id], ['wallet']]);

  if (e.status === 'draft' || e.status === 'awaiting_funds') {
    return (
      <Card style={{ gap: 12 }}>
        <Body>{T('post.deposit')}</Body>
        <PrimaryButton label={T('post.submit')} loading={fund.isPending} onPress={() => fund.mutate({ body: { rail: 'wallet' } })} />
        <SecondaryButton style={{ flex: 0 }} label={T('post.submit_mpesa')} onPress={() => fund.mutate({ body: { rail: 'mpesa_stk' } })} />
        {fund.error instanceof ApiError ? <Notice>{fund.error.message}</Notice> : null}
      </Card>
    );
  }
  if (e.status === 'open' || e.status === 'offered') return <Choosing e={e} onCancel={() => cancel.mutate({ body: {} })} />;

  return (
    <>
      <Progress e={e} />
      {e.runner ? (
        <Card style={{ gap: 6 }}>
          <Heading>{e.runner.display_name}</Heading>
          <Meta>{T('profile.tier', { tier: e.runner.verification_tier })}</Meta>
          <LocationLine link={link} />
        </Card>
      ) : null}
      {e.stalls.length > 0 ? <Eyebrow>{T('post.stalls')}</Eyebrow> : null}
      {e.stalls.map((s) => (
        <SunkRow key={s.id} accessibilityLabel={`${s.name}, ${T(`status.${s.status === 'photographed' ? 'awaiting_approval' : e.status}` as Key)}`}
          onPress={s.status === 'photographed' || e.tranches.some((x) => x.stall_id === s.id && x.status === 'pending')
            ? () => router.push(`/stall/${e.id}/${s.id}`) : undefined}>
          <StallMark status={s.status} />
          <Text style={{ flex: 1, fontFamily: t.fontBody, fontSize: t.size.body, color: t.text }}>{s.name}</Text>
          <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.textMuted }}>{s.total_cents ? kes(s.total_cents, T.locale) : ''}</Text>
        </SunkRow>
      ))}
      {e.status === 'handover' ? <HandoverQr e={e} /> : null}
      <Actions e={e} />
    </>
  );
}

function Choosing({ e, onCancel }: { e: ErrandDetail; onCancel: () => void }) {
  const T = useT();
  const bids = useBids(e.id, true);
  const nearby = useNearby(e.id, e.assignment_mode === 'pick' || e.status === 'open');
  const award = useAction<{ bid_id: string }>(() => `/errands/${e.id}/award`, [['errand', e.id]]);
  const offer = useAction<{ runner_id: string; fee_cents: number }>(() => `/errands/${e.id}/offer`, [['errand', e.id]]);
  const invite = useAction<{ runner_id: string; fee_cents: number }>(() => `/errands/${e.id}/invite`, [['errand', e.id]]);
  const regulars = e.assignment_mode === 'pick' || e.status !== 'open'
    ? []
    : (nearby.data ?? []).filter((r) => r.completed_with_you > 0);
  const b = bids.data;
  const actionError = [award.error, offer.error, invite.error].find((x) => x instanceof ApiError) as ApiError | undefined;
  return (
    <>
      <Eyebrow>{T('live.offers')}</Eyebrow>
      {b?.sealed ? (
        <Body color={t.textMuted}>{T('live.sealed', { n: b.count, time: new Date(b.closes_at).toLocaleTimeString(T.locale, { hour: '2-digit', minute: '2-digit' }) })}</Body>
      ) : null}
      {b && !b.sealed ? b.bids.map((x) => (
        <Card key={x.id} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Heading>{x.runner.display_name}</Heading>
            <Heading>{kes(x.fee_cents, T.locale)}</Heading>
          </View>
          <Meta>{`${T('profile.tier', { tier: x.runner.verification_tier })} · ${x.eta_minutes} min`}</Meta>
          {x.note ? <Body>{x.note}</Body> : null}
          <PrimaryButton label={T('live.choose', { name: x.runner.display_name })} loading={award.isPending}
            onPress={() => award.mutate({ body: { bid_id: x.id } })} />
        </Card>
      )) : null}
      {e.assignment_mode === 'pick' ? (
        <>
          <Eyebrow style={{ marginTop: 6 }}>{T('live.nearby')}</Eyebrow>
          {(nearby.data ?? []).map((r) => (
            <SunkRow key={r.runner_id} accessibilityLabel={`${r.display_name}, ${T(`feed.band.${r.distance_band}` as Key)}`}
              onPress={e.status === 'open' ? () => offer.mutate({ body: { runner_id: r.runner_id, fee_cents: e.max_fee_cents } }) : undefined}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.text }}>{r.display_name}</Text>
                <Meta>{T(`feed.band.${r.distance_band}` as Key)}</Meta>
              </View>
              <Text style={{ fontFamily: t.fontBodySemi, fontSize: t.size.body, color: t.accentDeep }}>{T('live.offer_to', { amount: kes(e.max_fee_cents, T.locale) })}</Text>
            </SunkRow>
          ))}
        </>
      ) : null}
      {regulars.length > 0 ? (
        <>
          <Eyebrow style={{ marginTop: 6 }}>{T('live.regulars')}</Eyebrow>
          <Meta>{T('live.regulars_body')}</Meta>
          {regulars.map((r) => (
            <SunkRow key={r.runner_id} accessibilityLabel={`${r.display_name}, ${T('live.done_with_you', { n: r.completed_with_you })}`}
              onPress={invite.isPending ? undefined : () => invite.mutate({ body: { runner_id: r.runner_id, fee_cents: e.max_fee_cents } })}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.text }}>{r.display_name}</Text>
                <Meta>{T('live.done_with_you', { n: r.completed_with_you })}</Meta>
              </View>
              <Text style={{ fontFamily: t.fontBodySemi, fontSize: t.size.body, color: t.accentDeep }}>{T('live.invite', { amount: kes(e.max_fee_cents, T.locale) })}</Text>
            </SunkRow>
          ))}
        </>
      ) : null}
      {actionError ? <Notice>{actionError.message}</Notice> : null}
      <SecondaryButton style={{ flex: 0, marginTop: 8 }} label={T('live.cancel')} onPress={onCancel} />
    </>
  );
}

function Progress({ e }: { e: ErrandDetail }) {
  const T = useT();
  const pct = e.eta?.percent_complete ?? 0;
  const mins = e.eta?.eta_at ? Math.max(1, Math.round((new Date(e.eta.eta_at).getTime() - Date.now()) / 60_000)) : null;
  return (
    <Card style={{ gap: 10 }}>
      <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: pct }}
        style={{ height: 6, borderRadius: 999, backgroundColor: t.track, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: 6, backgroundColor: t.accent2 }} />
      </View>
      {/* At low confidence the ETA is a range, never a minute (eta.ts shouldShowExactTime). */}
      {mins !== null ? (
        <Meta>{e.eta?.confidence === 'low' ? T('live.eta_range', { low: Math.round(mins * 0.8), high: Math.round(mins * 1.5) }) : T('live.eta', { min: mins })}</Meta>
      ) : null}
    </Card>
  );
}

function LocationLine({ link }: { link: ReturnType<typeof useLink> }) {
  const T = useT();
  if (!link.peer) return null;
  const age = Math.round((Date.now() - new Date(link.peer.at).getTime()) / 1000);
  const stale = age > 90;
  return (
    <Pressable accessibilityRole="link" onPress={() => Linking.openURL(`geo:${link.peer!.lat},${link.peer!.lng}?q=${link.peer!.lat},${link.peer!.lng}`)}
      style={{ minHeight: metrics.hitFloor, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {stale ? <ClockIcon color={t.textFaint} size={16} /> : <CheckIcon color={t.accent2} />}
      <Meta color={stale ? t.textFaint : t.accent2}>
        {stale ? T('live.location_stale', { age: age > 120 ? `${Math.round(age / 60)} min` : `${age}s` }) : T('live.location_live')}
      </Meta>
    </Pressable>
  );
}

function StallMark({ status }: { status: string }) {
  if (status === 'approved') return <CheckIcon color={t.accent2} />;
  if (status === 'photographed') return <AlertIcon color={t.accent} />;
  if (status === 'declined' || status === 'skipped') return <Text style={{ color: t.textFaint }}>–</Text>;
  return <ClockIcon color={t.textFaint} size={16} />;
}

function HandoverQr({ e }: { e: ErrandDetail }) {
  const T = useT();
  // Server-issued and rotating every 60s: refetch when it is about to roll over.
  const q = useQuery({
    queryKey: ['handover', e.id],
    queryFn: () => api.get<HandoverToken>(`/errands/${e.id}/handover-token`),
    refetchInterval: (s) => Math.max(1000, (s.state.data?.rotates_in_ms ?? 30_000) + 250),
  });
  return (
    <Card style={{ alignItems: 'center', gap: 12 }}>
      <Heading>{T('live.handover')}</Heading>
      {q.data ? <View style={{ padding: 12, backgroundColor: '#ffffff', borderRadius: 16 }}><QRCode value={q.data.qr_token} size={220} color={t.ink} backgroundColor="#ffffff" /></View> : null}
      <Body style={{ textAlign: 'center' }}>{T('live.handover_body', { runner: e.runner?.display_name ?? '' })}</Body>
    </Card>
  );
}

function Actions({ e }: { e: ErrandDetail }) {
  const T = useT();
  const [sos, setSos] = useState<string | null>(null);
  const sosAct = useAction(() => `/errands/${e.id}/sos`);
  const other = e.requester.id === useSession.getState().account?.id ? e.runner?.display_name : e.requester.display_name;
  return (
    <View style={{ gap: 10, marginTop: 6 }}>
      {other ? <SecondaryButton style={{ flex: 0 }} label={T('live.message', { name: other })} onPress={() => router.push(`/chat/${e.id}`)} /> : null}
      <SecondaryButton style={{ flex: 0 }} label={T('live.report')} onPress={() => router.push({ pathname: '/chat/[id]', params: { id: e.id, report: '1' } })} />
      <PrimaryButton label={T('live.sos')} onPress={() => sosAct.mutate({ body: {} }, { onSuccess: (r) => { const d = (r as { dial: string }).dial; setSos(d); Linking.openURL(d); } })} />
      {sos ? <Notice>{T('sos.body')}</Notice> : null}
    </View>
  );
}

// ─────────────────────────────────────────── runner

function RunnerView({ e }: { e: ErrandDetail }) {
  const T = useT();
  const me = useSession((s) => s.account);
  const inv = [['errand', e.id]] as const;
  const start = useAction(() => `/errands/${e.id}/start`, inv);
  const arrive = useAction(() => `/errands/${e.id}/arrive`, inv);
  const ready = useAction(() => `/errands/${e.id}/ready`, inv);
  const accept = useAction(() => `/errands/${e.id}/accept`, inv);
  const decline = useAction(() => `/errands/${e.id}/decline-offer`, inv);
  const err = [start, arrive, ready, accept, decline].map((m) => m.error).find((x) => x instanceof ApiError) as ApiError | undefined;

  useEffect(() => { if (e.status === 'settled') router.replace('/earnings'); }, [e.status]);

  if (e.status === 'offered' && e.runner === null) {
    return (
      <Card style={{ gap: 12 }}>
        <Heading>{T('feed.offer')}</Heading>
        <Body>{kes(e.agreed_fee_cents, T.locale)}</Body>
        <PrimaryButton label={T('feed.accept', { amount: kes(e.agreed_fee_cents, T.locale) })} loading={accept.isPending} onPress={() => accept.mutate({ body: {} })} />
        <SecondaryButton style={{ flex: 0 }} label={T('feed.decline')} onPress={() => decline.mutate({ body: {} }, { onSuccess: () => router.back() })} />
        {err ? <Notice>{err.message}</Notice> : null}
      </Card>
    );
  }
  if (e.runner?.id !== me?.id) return <Notice>{T('error.generic')}</Notice>;

  return (
    <>
      <Progress e={e} />
      {e.card ? (
        <Card style={{ gap: 4 }}>
          <Eyebrow>{T('active.card')}</Eyebrow>
          <Heading size={23} style={{ fontVariant: ['tabular-nums'] }}>{`•••• •••• •••• ${e.card.last4}`}</Heading>
          <Meta>{T('active.card_balance', { amount: kes(e.card.loaded_cents, T.locale) })}</Meta>
        </Card>
      ) : null}
      {e.status === 'awarded' ? <PrimaryButton label={T('active.start')} loading={start.isPending} onPress={() => start.mutate({ body: {} })} /> : null}
      {e.status === 'en_route' ? <PrimaryButton label={T('active.arrive')} loading={arrive.isPending} onPress={() => arrive.mutate({ body: {} })} /> : null}
      {(e.status === 'awarded' || e.status === 'en_route') && me?.entitlements.includes('batch.create') ? (
        <SecondaryButton style={{ flex: 0 }} label={T('active.batch')} onPress={() => router.push(`/batch/${e.id}`)} />
      ) : null}
      {(e.status === 'shopping' || e.status === 'awaiting_approval') ? e.stalls.map((s) => (
        <SunkRow key={s.id} onPress={() => router.push(`/run/${e.id}/${s.id}`)} accessibilityLabel={s.name}>
          <StallMark status={s.status} />
          <Text style={{ flex: 1, fontFamily: t.fontBody, fontSize: t.size.body, color: t.text }}>{s.name}</Text>
          <Meta>{s.status === 'photographed' ? T('run.sent', { name: e.requester.display_name }) : s.status === 'approved' ? T('run.approved') : ''}</Meta>
        </SunkRow>
      )) : null}
      {e.status === 'shopping' && e.stalls.length === 0 ? (
        <PrimaryButton label={T('active.ready')} loading={ready.isPending} onPress={() => ready.mutate({ body: {} })} />
      ) : null}
      {e.status === 'handover' ? <PrimaryButton label={T('active.scan')} onPress={() => router.push(`/scan/${e.id}`)} /> : null}
      {err ? <Notice>{err.message}</Notice> : null}
      <Actions e={e} />
    </>
  );
}
