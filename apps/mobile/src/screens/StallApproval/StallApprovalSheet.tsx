// apps/mobile/src/screens/StallApproval/StallApprovalSheet.tsx
// The money screen, and the one screen held to pixel parity across platforms (parity design §2,
// 11-cross-platform.md §11.4). Everything below is in the same order, at the same sizes, with
// the same words on both: photo, itemised prices, running total, remaining cap, actions. What
// adapts is only feel — the drag affordance, the press physics, the button height, the haptic —
// and all of that comes from platform/adaptive.ts.
//
// Approvals are never optimistic: the button stays loading until the server acknowledges, and
// the sheet closes only on `tranche.loaded`. `tranche.failed` replaces the body with the ladder
// state and does not dismiss itself.

import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tokens as t } from '../../theme/tokens';
import { metrics, haptic, announce, confirmPresentation } from '../../platform/adaptive';
import { useT, type Key } from '../../i18n/useT';
import { kes, toMinor } from '../../lib/money';
import { ApiError } from '../../lib/api';
import { Sheet } from '../../components/Sheet';
import { ConfirmDestructive } from '../../components/ConfirmDestructive';
import { PrimaryButton, SecondaryButton, Notice, Field, Chip, Eyebrow } from '../../components/ui';
import { useStall, useApproveStall, useTrancheStatus, useDeclineStall, useSubstitute } from '../../features/stalls/hooks';
import { LadderState } from './LadderState';

interface Props {
  errandId: string;
  stallId: string;
  onClose: () => void;
}

export function StallApprovalSheet({ errandId, stallId, onClose }: Props) {
  const T = useT();
  const insets = useSafeAreaInsets();
  const q = useStall(errandId, stallId);
  const approve = useApproveStall(errandId, stallId);
  const tranche = useTrancheStatus(errandId, approve.data?.tranche.id);
  const decline = useDeclineStall(errandId, stallId);
  const [confirming, setConfirming] = useState(false);
  const [substituting, setSubstituting] = useState(false);

  const stall = q.data?.stall;
  const errand = q.data?.errand;
  const remaining = errand ? errand.spend_cap_cents - errand.spent_cents : 0;
  const overCap = stall ? stall.total_cents > remaining : false;
  const runnerName = errand?.runner?.display_name ?? '';

  // An existing tranche for this stall (the sheet was reopened mid-load, or the ladder is
  // waiting on the requester) takes precedence over a fresh approval.
  const existing = errand?.tranches.find((x) => x.stall_id === stallId);
  const status = tranche.data?.status ?? (existing && stall?.status === 'approved' ? existing.status : undefined);
  const waitingOnMe = existing?.attempts.some((a) => a.rung === 'reimbursement' && a.result === 'pending');

  useEffect(() => {
    if (status === 'loaded') { haptic.success(); onClose(); }
    if (status === 'failed') haptic.problem();
  }, [status, onClose]);

  // The one state a sighted user sees as a colour change is also spoken (§11.5).
  useEffect(() => {
    if (overCap && stall) announce(T('stall.over_cap', { over: kes(stall.total_cents - remaining, T.locale) }));
  }, [overCap]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = approve.isPending || status === 'pending';
  const bottom = Math.max(insets.bottom, metrics.sheetBottomPad);

  if (q.isError || (q.isSuccess && !stall)) {
    // Never a spinner that cannot end: say what happened and offer the way out.
    return (
      <Sheet onClose={onClose} bottomInset={bottom}>
        <View style={{ padding: metrics.gutter, gap: 12 }}>
          <Notice>{q.error instanceof ApiError && q.error.status !== 0 ? q.error.message : T('error.generic')}</Notice>
          <SecondaryButton label={T('error.retry')} onPress={() => q.refetch()} style={{ flex: 0 }} />
        </View>
      </Sheet>
    );
  }

  if (q.isLoading || !stall || !errand) {
    return (
      <Sheet onClose={onClose} bottomInset={bottom}>
        <View style={{ padding: 40, alignItems: 'center' }}><ActivityIndicator color={t.accent} /></View>
      </Sheet>
    );
  }

  if (status === 'failed' || (existing && waitingOnMe)) {
    return (
      <Sheet onClose={onClose} bottomInset={bottom} dismissible={status === 'failed'}>
        <LadderState errand={errand} trancheId={existing?.id ?? approve.data!.tranche.id} onClose={onClose} />
      </Sheet>
    );
  }

  const approveError = approve.error instanceof ApiError ? approve.error : null;
  const items = stall.items.filter((i) => i.accepted !== false);

  return (
    <Sheet onClose={onClose} bottomInset={bottom} dismissible={!pending}>
      <ScrollView contentContainerStyle={{ paddingTop: 14, paddingHorizontal: metrics.gutter }} bounces={false}>
        <Text accessibilityRole="header" style={{ fontFamily: t.fontHeading, fontSize: t.size.title, color: t.text }}>{stall.name}</Text>
        <Text style={{ fontFamily: t.fontBody, fontSize: t.size.meta, color: t.textFaint, marginTop: 2 }}>
          {T('stall.of', { seq: stall.seq, total: errand.stalls.length })}
        </Text>

        <View style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: t.radius.photo, marginTop: 14, backgroundColor: t.surfaceSunk,
          borderWidth: 1, borderColor: t.borderSunk, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {stall.photo_url ? (
            <Image source={{ uri: stall.photo_url }} accessibilityLabel={T('stall.photo')} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          ) : (
            <Text style={{ fontFamily: t.fontBody, fontSize: t.size.meta, color: t.textFaint }}>{T('stall.photo')}</Text>
          )}
        </View>

        <View style={{ marginTop: 16, gap: 8 }}>
          {items.map((item) => (
            <View key={item.id} accessible accessibilityLabel={`${item.label}, ${item.qty} ${unit(T, item.unit, item.qty)}, ${kes(item.price_cents, T.locale)}`}
              style={{ backgroundColor: t.surfaceSunk, borderRadius: t.radius.sunk, paddingVertical: 12, paddingHorizontal: 14,
                flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: metrics.tap }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.text }}>{item.label}</Text>
                <Text style={{ fontFamily: t.fontBody, fontSize: t.size.meta, color: t.textMuted, marginTop: 1 }}>
                  {`${item.qty} ${unit(T, item.unit, item.qty)}`}
                </Text>
                {item.substituted_for_label ? (
                  <Text style={{ fontFamily: t.fontBody, fontSize: 11, color: t.accent2, marginTop: 3 }}>
                    {T('stall.substituted', { original: item.substituted_for_label })}
                  </Text>
                ) : null}
              </View>
              <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.text, fontVariant: ['tabular-nums'] }}>
                {kes(item.price_cents, T.locale)}
              </Text>
            </View>
          ))}
        </View>

        <View style={{ marginTop: 18, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <View>
            <Text style={{ fontFamily: t.fontBodySemi, fontSize: t.size.eyebrow, letterSpacing: 1.1, textTransform: 'uppercase', color: t.textFaint }}>
              {T('stall.total')}
            </Text>
            <Text style={{ fontFamily: t.fontHeading, fontSize: t.size.hero, color: overCap ? t.accentDeep : t.text }}>
              {kes(stall.total_cents, T.locale)}
            </Text>
          </View>
          <Text style={{ fontFamily: t.fontBody, fontSize: t.size.meta, color: t.textFaint, marginBottom: 4, flexShrink: 1, textAlign: 'right' }}>
            {T('stall.remaining', { amount: kes(remaining, T.locale) })}
          </Text>
        </View>

        {overCap ? (
          <View style={{ marginTop: 12 }}>
            <Notice>{T('stall.over_cap', { over: kes(stall.total_cents - remaining, T.locale) })}</Notice>
          </View>
        ) : null}
        {approveError && approveError.code !== 'SPEND_CAP_EXCEEDED' ? (
          <View style={{ marginTop: 12 }}><Notice>{approveError.message}</Notice></View>
        ) : null}

        {substituting ? (
          <SubstituteForm errandId={errandId} stallId={stallId} items={items} onDone={() => setSubstituting(false)} />
        ) : (
          <>
            <PrimaryButton
              style={{ marginTop: 16 }}
              label={T('stall.approve', { amount: kes(stall.total_cents, T.locale) })}
              accessibilityLabel={T('stall.approve_a11y', { amount: kes(stall.total_cents, T.locale), name: stall.name })}
              loading={pending}
              loadingLabel={T('stall.loading_card')}
              disabled={overCap || stall.status !== 'photographed'}
              onPress={() => { haptic.moneyCommitted(); approve.mutate(); }}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 10, marginBottom: 4 }}>
              <SecondaryButton label={T('stall.substitute')} disabled={pending} onPress={() => setSubstituting(true)} />
              <SecondaryButton label={T('stall.decline')} disabled={pending} onPress={() => setConfirming(true)} />
            </View>
          </>
        )}
      </ScrollView>

      <ConfirmDestructive
        visible={confirming}
        title={T('decline.title')}
        // Same two facts on both (stall goes back, nothing is charged), worded for the shape
        // each platform draws: an action-sheet message, or a dialog body under a headline.
        body={T(confirmPresentation.kind === 'action-sheet' ? 'decline.body_ios' : 'decline.body_android', { runner: runnerName })}
        confirmLabel={T(confirmPresentation.kind === 'action-sheet' ? 'decline.confirm_ios' : 'decline.confirm_android')}
        alternativeLabel={T('decline.alternative')}
        cancelLabel={T('decline.cancel')}
        onCancel={() => setConfirming(false)}
        onAlternative={() => { setConfirming(false); setSubstituting(true); }}
        onConfirm={() => {
          setConfirming(false);
          decline.mutate(T('decline.reason_default'), { onSuccess: onClose });
        }}
      />
    </Sheet>
  );
}

function unit(T: ReturnType<typeof useT>, u: string, qty: number): string {
  const plural = u === 'bunch' && qty !== 1 ? 'bunches' : u;
  const key = `unit.${plural}` as Key;
  const out = T(key);
  return out === key ? u : out;
}

function SubstituteForm({ errandId, stallId, items, onDone }: {
  errandId: string; stallId: string; items: { id: string; label: string; qty: number; unit: string }[]; onDone: () => void;
}) {
  const T = useT();
  const sub = useSubstitute(errandId, stallId);
  const [target, setTarget] = useState(items[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [price, setPrice] = useState('');
  const chosen = useMemo(() => items.find((i) => i.id === target), [items, target]);
  const minor = toMinor(price);
  return (
    <View style={{ marginTop: 16, gap: 12 }}>
      <Eyebrow>{T('sub.item')}</Eyebrow>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {items.map((i) => <Chip key={i.id} label={i.label} selected={i.id === target} onPress={() => setTarget(i.id)} />)}
      </View>
      <Field label={T('sub.label')} value={label} onChangeText={setLabel} />
      <Field label={T('sub.price')} value={price} onChangeText={setPrice} keyboardType="decimal-pad" />
      {sub.error instanceof ApiError ? <Notice>{sub.error.message}</Notice> : null}
      <PrimaryButton label={T('sub.save')} loading={sub.isPending} disabled={!chosen || !label.trim() || minor === null}
        onPress={() => chosen && minor !== null && sub.mutate(
          { line_item_id: chosen.id, label: label.trim(), qty: chosen.qty, unit: chosen.unit, price_cents: minor },
          { onSuccess: onDone },
        )} />
      <SecondaryButton label={T('common.cancel')} onPress={onDone} style={{ flex: 0 }} />
    </View>
  );
}
