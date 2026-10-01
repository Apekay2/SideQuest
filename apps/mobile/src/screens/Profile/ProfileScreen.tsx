// Shared by both modes: language (EN/SW), mode switch, verification, sign-out.

import { View } from 'react-native';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Me } from '@sidequest/contracts';
import { useT } from '../../i18n/useT';
import { api, restoreSession } from '../../lib/api';
import { useSession } from '../../lib/session';
import { unregisterPush } from '../../lib/push';
import { useKyc } from '../../features/errands/hooks';
import { Screen } from '../../components/Screen';
import { Card, Chip, Eyebrow, Heading, Meta, PrimaryButton, SecondaryButton, Notice } from '../../components/ui';

export function ProfileScreen() {
  const T = useT();
  const qc = useQueryClient();
  const me = useSession((s) => s.account);
  const setAccount = useSession((s) => s.setAccount);
  const signOut = useSession((s) => s.signOut);
  const kyc = useKyc();
  if (!me) return null;
  const target = me.role === 'runner' ? 3 : Math.min(me.verification_tier + 1, 3);

  async function patch(body: Partial<Pick<Me, 'language' | 'role'>>) {
    const r = await api.patch<Me & { refresh_required?: boolean }>('/me', body);
    setAccount(r);
    if (r.refresh_required) {
      await restoreSession();           // new claims for the new role
      qc.clear();
      router.replace(r.role === 'runner' ? '/feed' : '/home');
    }
  }

  return (
    <Screen title={T('profile.title')}>
      <Card>
        <Heading size={22}>{me.display_name}</Heading>
        <Meta style={{ marginTop: 4 }}>{T('profile.tier', { tier: me.verification_tier })}</Meta>
      </Card>
      {kyc.data?.status === 'submitted' || kyc.data?.status === 'in_review' ? <Notice tone="ok">{T('profile.kyc_pending')}</Notice> : null}
      {kyc.data?.status === 'rejected' ? <Notice>{T('profile.kyc_rejected', { reason: kyc.data.reject_reason ?? '' })}</Notice> : null}
      {me.verification_tier < 3 && kyc.data?.status !== 'submitted' ? (
        <PrimaryButton label={T('profile.verify', { tier: target })} onPress={() => router.push('/kyc')} />
      ) : null}
      <Eyebrow style={{ marginTop: 6 }}>{T('profile.language')}</Eyebrow>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Chip label="English" selected={me.language === 'en'} onPress={() => patch({ language: 'en' })} />
        <Chip label="Kiswahili" selected={me.language === 'sw'} onPress={() => patch({ language: 'sw' })} />
      </View>
      <Eyebrow style={{ marginTop: 6 }}>{T('profile.role')}</Eyebrow>
      <View style={{ flexDirection: 'row' }}>
        <SecondaryButton
          label={me.role === 'runner' ? T('profile.switch_requester') : T('profile.switch_runner')}
          onPress={() => patch({ role: me.role === 'runner' ? 'requester' : 'runner' })}
        />
      </View>
      <View style={{ flexDirection: 'row', marginTop: 12 }}>
        <SecondaryButton label={T('profile.sign_out')} onPress={async () => {
          await api.post('/auth/logout').catch(() => undefined);
          await unregisterPush(); await signOut(); qc.clear(); router.replace('/sign-in');
        }} />
      </View>
    </Screen>
  );
}
