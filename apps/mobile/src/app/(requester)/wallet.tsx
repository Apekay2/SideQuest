import { useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { tokens as t } from '../../theme/tokens';
import { useT, type Key } from '../../i18n/useT';
import { kes, toMinor } from '../../lib/money';
import { ApiError } from '../../lib/api';
import { useWallet, useAction } from '../../features/errands/hooks';
import { Screen } from '../../components/Screen';
import { Card, Eyebrow, Heading, Meta, PrimaryButton, SecondaryButton, SunkRow, Field, Notice } from '../../components/ui';

export default function WalletScreen() {
  const T = useT();
  const w = useWallet();
  const topup = useAction<{ amount_cents: number }>(() => '/wallet/topup', [['wallet']]);
  const withdraw = useAction<{ amount_cents: number }>(() => '/wallet/withdraw', [['wallet']]);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const held = (w.data?.escrow ?? []).reduce((a, e) => a + e.held_cents, 0);
  const minor = toMinor(amount);
  const err = (topup.error ?? withdraw.error) as ApiError | null;

  return (
    <Screen title={T('wallet.title')} onRefresh={() => w.refetch()} refreshing={w.isRefetching}>
      <Card>
        <Eyebrow>{T('wallet.available')}</Eyebrow>
        <Heading size={32} style={{ marginTop: 6 }}>{kes(w.data?.balance_cents, T.locale)}</Heading>
        {held > 0 ? <Meta style={{ marginTop: 4 }}>{T('wallet.held', { amount: kes(held, T.locale) })}</Meta> : null}
        <View style={{ marginTop: 14, gap: 10 }}>
          <Field label={T('wallet.amount')} value={amount} onChangeText={setAmount} keyboardType="number-pad" />
          <PrimaryButton label={T('wallet.topup')} loading={topup.isPending} disabled={!minor}
            onPress={() => minor && topup.mutate({ body: { amount_cents: minor } }, { onSuccess: () => setNote(T('wallet.topup_sent')) })} />
          <View style={{ flexDirection: 'row' }}>
            <SecondaryButton label={T('wallet.withdraw')} disabled={!minor || withdraw.isPending}
              onPress={() => minor && withdraw.mutate({ body: { amount_cents: minor } })} />
          </View>
        </View>
      </Card>
      {note ? <Notice tone="ok">{note}</Notice> : null}
      {err ? <Notice>{err.message}</Notice> : null}
      {(w.data?.escrow.length ?? 0) > 0 ? <Eyebrow style={{ marginTop: 6 }}>{T('wallet.escrow')}</Eyebrow> : null}
      {(w.data?.escrow ?? []).map((e) => (
        <SunkRow key={e.errand_id} onPress={() => router.push(`/errand/${e.errand_id}`)}>
          <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.text, flex: 1 }}>{e.title}</Text>
          <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.textMuted }}>{kes(e.held_cents, T.locale)}</Text>
        </SunkRow>
      ))}
      <Eyebrow style={{ marginTop: 6 }}>{T('wallet.recent')}</Eyebrow>
      {(w.data?.recent ?? []).map((r) => (
        <SunkRow key={r.id}>
          <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.text, flex: 1 }}>{ledgerLabel(T, r.reason)}</Text>
          <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: r.amount_cents < 0 ? t.textMuted : t.accent2, fontVariant: ['tabular-nums'] }}>
            {r.amount_cents < 0 ? '−' : '+'}{kes(Math.abs(r.amount_cents), T.locale)}
          </Text>
        </SunkRow>
      ))}
    </Screen>
  );
}

function ledgerLabel(T: ReturnType<typeof useT>, reason: string): string {
  const key = `ledger.${reason}` as Key;
  const out = T(key);
  return out === key ? T('ledger.other') : out;
}
