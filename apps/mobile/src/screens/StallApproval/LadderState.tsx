// apps/mobile/src/screens/StallApproval/LadderState.tsx
// What the requester sees when the card could not pay (05-ui-architecture §5.5 step 8): what
// was tried, what happens next, and the one action they can take. It does not dismiss itself.

import { ScrollView, Text, View } from 'react-native';
import type { ErrandDetail } from '@sidequest/contracts';
import { tokens as t } from '../../theme/tokens';
import { metrics } from '../../platform/adaptive';
import { useT, type Key } from '../../i18n/useT';
import { kes } from '../../lib/money';
import { Notice, PrimaryButton, SecondaryButton, Eyebrow } from '../../components/ui';
import { useReimbursement } from '../../features/stalls/hooks';

export function LadderState({ errand, trancheId, onClose }: { errand: ErrandDetail; trancheId: string; onClose: () => void }) {
  const T = useT();
  const reimb = useReimbursement(errand.id);
  const tr = errand.tranches.find((x) => x.id === trancheId);
  const tried = (tr?.attempts ?? []).filter((a) => a.rung !== 'reimbursement').map((a) => T(`ladder.rung.${a.rung}` as Key)).join(' → ');
  const asking = tr?.attempts.some((a) => a.rung === 'reimbursement' && a.result === 'pending');
  const runner = errand.runner?.display_name ?? '';

  return (
    <ScrollView contentContainerStyle={{ paddingTop: 14, paddingHorizontal: metrics.gutter, gap: 14, paddingBottom: 8 }}>
      <Text accessibilityRole="header" style={{ fontFamily: t.fontHeading, fontSize: t.size.title, color: t.text }}>{T('ladder.title')}</Text>
      {tried ? <Text style={{ fontFamily: t.fontBody, fontSize: t.size.meta, color: t.textFaint }}>{T('ladder.tried', { rungs: tried })}</Text> : null}
      <View style={{ gap: 6 }}>
        <Eyebrow>{T('ladder.next')}</Eyebrow>
        {asking ? (
          <Notice>{T('ladder.reimburse', { runner, amount: kes(tr?.amount_cents ?? 0, T.locale) })}</Notice>
        ) : (
          <Notice>{T('ladder.escalated')}</Notice>
        )}
      </View>
      {asking ? (
        <>
          <PrimaryButton label={T('ladder.reimburse_yes')} loading={reimb.isPending}
            onPress={() => reimb.mutate({ tranche_id: trancheId, accept: true }, { onSuccess: onClose })} />
          <SecondaryButton label={T('ladder.reimburse_no')} disabled={reimb.isPending} style={{ flex: 0 }}
            onPress={() => reimb.mutate({ tranche_id: trancheId, accept: false }, { onSuccess: onClose })} />
        </>
      ) : (
        <SecondaryButton label={T('ladder.close')} onPress={onClose} style={{ flex: 0 }} />
      )}
    </ScrollView>
  );
}
