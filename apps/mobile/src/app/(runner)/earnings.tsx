import { useState } from 'react';
import { Text } from 'react-native';
import { tokens as t } from '../../theme/tokens';
import { useT, type Key } from '../../i18n/useT';
import { kes, toMinor } from '../../lib/money';
import { ApiError } from '../../lib/api';
import { useEarnings, useAction } from '../../features/errands/hooks';
import { Screen } from '../../components/Screen';
import { Card, Eyebrow, Heading, Meta, Field, PrimaryButton, SunkRow, Notice } from '../../components/ui';

export default function Earnings() {
  const T = useT();
  const e = useEarnings();
  const pay = useAction<{ amount_cents: number }>(() => '/payouts', [['earnings']]);
  const [amount, setAmount] = useState('');
  const minor = toMinor(amount);
  return (
    <Screen title={T('earnings.title')} onRefresh={() => e.refetch()} refreshing={e.isRefetching}>
      <Card style={{ gap: 6 }}>
        <Eyebrow>{T('earnings.available')}</Eyebrow>
        <Heading size={32}>{kes(e.data?.available_cents, T.locale)}</Heading>
        {e.data?.reimbursements_owed_cents ? <Meta>{T('earnings.owed', { amount: kes(e.data.reimbursements_owed_cents, T.locale) })}</Meta> : null}
        <Field label={T('wallet.amount')} value={amount} onChangeText={setAmount} keyboardType="number-pad" />
        <Meta>{T('earnings.min', { amount: kes(e.data?.min_payout_cents ?? 10000, T.locale) })}</Meta>
        <PrimaryButton label={T('earnings.cash_out')} loading={pay.isPending}
          disabled={!minor || minor < (e.data?.min_payout_cents ?? 10000) || minor > (e.data?.available_cents ?? 0)}
          onPress={() => minor && pay.mutate({ body: { amount_cents: minor } }, { onSuccess: () => setAmount('') })} />
      </Card>
      {pay.error instanceof ApiError ? <Notice>{pay.error.message}</Notice> : null}
      <Eyebrow style={{ marginTop: 6 }}>{T('earnings.payouts')}</Eyebrow>
      {(e.data?.payouts ?? []).map((p) => (
        <SunkRow key={p.id}>
          <Text style={{ flex: 1, fontFamily: t.fontBody, fontSize: t.size.body, color: t.text }}>{new Date(p.at).toLocaleDateString(T.locale)}</Text>
          <Meta>{T(`payout.${p.status}` as Key)}</Meta>
          <Text style={{ fontFamily: t.fontBody, fontSize: t.size.body, color: t.textMuted }}>{kes(p.amount_cents, T.locale)}</Text>
        </SunkRow>
      ))}
    </Screen>
  );
}
