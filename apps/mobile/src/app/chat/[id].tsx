// Messages between the two parties, and the report form (which freezes escrow). Messages join
// the evidence pack if a report is opened.

import { useState } from 'react';
import { KeyboardAvoidingView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { tokens as t } from '../../theme/tokens';
import { useT, type Key } from '../../i18n/useT';
import { ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useMessages, useAction } from '../../features/errands/hooks';
import { Screen } from '../../components/Screen';
import { Body, Chip, Field, Notice, PrimaryButton } from '../../components/ui';

const REASONS = ['goods_wrong', 'overcharged', 'no_show', 'safety', 'other'] as const;

export default function Chat() {
  const T = useT();
  const { id, report } = useLocalSearchParams<{ id: string; report?: string }>();
  const me = useSession((s) => s.account?.id);
  const msgs = useMessages(id);
  const send = useAction<{ body: string }>(() => `/errands/${id}/messages`, [['messages', id]]);
  const dispute = useAction<{ errand_id: string; reason: string; detail: string }>(() => '/disputes', [['errand', id]]);
  const [text, setText] = useState('');
  const [reason, setReason] = useState<(typeof REASONS)[number]>('goods_wrong');

  if (report) {
    return (
      <Screen title={T('report.title')} back>
        <Notice>{T('report.body')}</Notice>
        <View style={{ gap: 8 }}>
          {REASONS.map((r) => <Chip key={r} label={T(`report.${r}` as Key)} selected={reason === r} onPress={() => setReason(r)} />)}
        </View>
        <Field label={T('report.detail')} value={text} onChangeText={setText} multiline style={{ minHeight: 100, paddingTop: 12, textAlignVertical: 'top' }} />
        {dispute.error instanceof ApiError ? <Notice>{dispute.error.message}</Notice> : null}
        <PrimaryButton label={T('report.submit')} loading={dispute.isPending} disabled={!text.trim()}
          onPress={() => dispute.mutate({ body: { errand_id: id, reason, detail: text.trim() } }, { onSuccess: () => router.back() })} />
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
      <Screen title={T('live.title')} back>
        {[...(msgs.data ?? [])].reverse().map((m) => (
          <View key={m.id} style={{ alignSelf: m.sender_id === me ? 'flex-end' : 'flex-start', maxWidth: '80%',
            backgroundColor: m.sender_id === me ? t.accentTint : t.surface, borderWidth: 1,
            borderColor: m.sender_id === me ? t.accentEdge : t.border, borderRadius: 18, padding: 12 }}>
            <Body>{m.body}</Body>
            <Text style={{ fontFamily: t.fontBody, fontSize: 11, color: t.textFaint, marginTop: 4 }}>
              {new Date(m.at).toLocaleTimeString(T.locale, { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        ))}
        <Field label={T('chat.placeholder')} value={text} onChangeText={setText} />
        <PrimaryButton label={T('chat.send')} disabled={!text.trim()} loading={send.isPending}
          onPress={() => send.mutate({ body: { body: text.trim() } }, { onSuccess: () => setText('') })} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
