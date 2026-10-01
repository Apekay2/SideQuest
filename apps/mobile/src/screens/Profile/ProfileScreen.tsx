// Shared by both modes: language (EN/SW), mode switch, verification, sign-out, and the
// privacy rights the law gives every user: their documents, location consent, a copy of their
// data, and closing the account (Kenya DPA 2019 s.26; App Store and Google Play deletion rules).

import { useState } from 'react';
import { Linking, Share, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LocationConsent, Me } from '@sidequest/contracts';
import { useT } from '../../i18n/useT';
import { api, ApiError, newIdemKey, restoreSession } from '../../lib/api';
import { TERMS_URL, PRIVACY_URL } from '../../lib/legal';
import { useSession } from '../../lib/session';
import { unregisterPush } from '../../lib/push';
import { useKyc } from '../../features/errands/hooks';
import { Screen } from '../../components/Screen';
import { ConfirmDestructive } from '../../components/ConfirmDestructive';
import { Card, Chip, Eyebrow, Heading, Meta, PrimaryButton, SecondaryButton, Notice } from '../../components/ui';

export function ProfileScreen() {
  const T = useT();
  const qc = useQueryClient();
  const me = useSession((s) => s.account);
  const setAccount = useSession((s) => s.setAccount);
  const signOut = useSession((s) => s.signOut);
  const kyc = useKyc();
  const tier3 = me?.verification_tier === 3;
  const consent = useQuery({ queryKey: ['location-consent'], enabled: tier3,
    queryFn: () => api.get<LocationConsent>('/me/location-consent') });
  const setConsent = useMutation({
    mutationFn: (v: boolean) => api.post('/me/location-consent', { consent: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['location-consent'] }),
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!me) return null;

  const failure = (e: unknown) => {
    const code = e instanceof ApiError ? e.code : '';
    if (code === 'ACCOUNT_HAS_BALANCE') return T('privacy.delete_balance');
    if (code === 'LIVE_ERRANDS') return T('privacy.delete_live');
    if (code === 'OPEN_DISPUTE') return T('privacy.delete_dispute');
    return T('error.generic');
  };

  async function exportData() {
    setBusy(true); setNotice(null);
    try {
      const data = await api.get<unknown>('/me/export');
      await Share.share({ title: T('privacy.export_title'), message: JSON.stringify(data, null, 2) });
    } catch (e) { setNotice(failure(e)); }
    finally { setBusy(false); }
  }

  async function deleteAccount() {
    setConfirmDelete(false); setBusy(true); setNotice(null);
    try {
      await api.post('/me/delete', { confirm: 'DELETE' }, { idem: newIdemKey() });
      await unregisterPush().catch(() => undefined);
      await signOut(); qc.clear(); router.replace('/sign-in');
    } catch (e) { setNotice(failure(e)); setBusy(false); }
  }
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

      <Eyebrow style={{ marginTop: 18 }}>{T('privacy.title')}</Eyebrow>
      {tier3 && consent.data && consent.data.consent !== null ? (
        <Card>
          <Meta>{T('privacy.location_body')}</Meta>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Chip label={T('privacy.location_on')} selected={consent.data.consent} onPress={() => setConsent.mutate(true)} />
            <Chip label={T('privacy.location_off')} selected={!consent.data.consent} onPress={() => setConsent.mutate(false)} />
          </View>
        </Card>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <SecondaryButton label={T('legal.terms')} onPress={() => Linking.openURL(TERMS_URL)} />
        <SecondaryButton label={T('legal.privacy')} onPress={() => Linking.openURL(PRIVACY_URL)} />
      </View>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <SecondaryButton label={T('privacy.export')} onPress={exportData} disabled={busy} />
        {me.role !== 'staff' ? <SecondaryButton label={T('privacy.delete')} onPress={() => setConfirmDelete(true)} disabled={busy} /> : null}
      </View>
      {notice ? <Notice>{notice}</Notice> : null}
      <ConfirmDestructive visible={confirmDelete} title={T('privacy.delete_title')} body={T('privacy.delete_body')}
        confirmLabel={T('privacy.delete_confirm')} cancelLabel={T('privacy.delete_cancel')}
        onConfirm={deleteAccount} onCancel={() => setConfirmDelete(false)} />
    </Screen>
  );
}
