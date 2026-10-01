// Runner trip planning. Batching shares a trip, never a card, an escrow or an approval:
// the server re-checks that every errand is the caller's and sits in one market catchment.

import { useState } from 'react';
import { Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { tokens as t } from '../../theme/tokens';
import { useT } from '../../i18n/useT';
import { kes } from '../../lib/money';
import { api, ApiError } from '../../lib/api';
import { useErrands, useAction } from '../../features/errands/hooks';
import { Screen } from '../../components/Screen';
import { Body, Eyebrow, Meta, Notice, PrimaryButton, SunkRow } from '../../components/ui';
import { CheckIcon } from '../../components/icons';

interface EligibleErrand { id: string; title: string; kind: string; max_fee_cents: number; deadline_at: string | null }

const BATCHABLE = new Set(['awarded', 'en_route']);

export default function BatchPlanner() {
  const T = useT();
  const { errandId } = useLocalSearchParams<{ errandId: string }>();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(errandId ? [errandId] : []));
  const [done, setDone] = useState(false);

  const live = useErrands('live', 'runner');
  const mine = (live.data ?? []).filter((e) => BATCHABLE.has(e.status));
  const eligible = useQuery({
    queryKey: ['batch-eligible', errandId],
    enabled: Boolean(errandId),
    queryFn: () => api.get<{ data: EligibleErrand[] }>(`/batches/eligible?errand_id=${errandId}`).then((r) => r.data),
    staleTime: 30_000,
  });
  const create = useAction<{ errand_ids: string[]; planned_for: string }>(() => '/batches', [['errands', 'live', 'runner']]);

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const ids = [...picked].filter((id) => mine.some((e) => e.id === id));
  const err = create.error instanceof ApiError ? create.error : undefined;

  return (
    <Screen title={T('batch.title')} back onRefresh={() => { live.refetch(); eligible.refetch(); }} refreshing={live.isRefetching}>
      <Body color={t.textMuted}>{T('batch.body')}</Body>

      <Eyebrow>{T('batch.mine')}</Eyebrow>
      {mine.map((e) => {
        const on = picked.has(e.id);
        return (
          <SunkRow key={e.id} onPress={done ? undefined : () => toggle(e.id)} accessibilityLabel={`${e.title}${on ? `, ${T('batch.selected')}` : ''}`}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.text }}>{e.title}</Text>
              <Meta>{kes(e.agreed_fee_cents ?? e.max_fee_cents, T.locale)}</Meta>
            </View>
            {on ? <CheckIcon /> : null}
          </SunkRow>
        );
      })}

      <Eyebrow style={{ marginTop: 6 }}>{T('batch.nearby')}</Eyebrow>
      {(eligible.data ?? []).length === 0 && !eligible.isLoading ? <Meta>{T('batch.nearby_empty')}</Meta> : null}
      {(eligible.data ?? []).map((e) => (
        <SunkRow key={e.id} onPress={() => router.push(`/errand/${e.id}`)} accessibilityLabel={e.title}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.text }}>{e.title}</Text>
            <Meta>{kes(e.max_fee_cents, T.locale)}</Meta>
          </View>
        </SunkRow>
      ))}

      {done ? <Notice tone="ok">{T('batch.done')}</Notice> : null}
      {err ? <Notice>{err.message}</Notice> : null}
      {!done && ids.length < 2 ? <Meta>{T('batch.pick_two')}</Meta> : null}
      {!done ? (
        <PrimaryButton
          label={T('batch.create', { n: ids.length })}
          disabled={ids.length < 2}
          loading={create.isPending}
          onPress={() => create.mutate({ body: { errand_ids: ids, planned_for: new Date().toISOString() } }, { onSuccess: () => setDone(true) })}
        />
      ) : null}
    </Screen>
  );
}
