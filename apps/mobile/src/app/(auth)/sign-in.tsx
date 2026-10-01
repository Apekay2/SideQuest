// Phone OTP sign-in. First-time numbers choose a mode and a first name; everyone else just
// enters the code. The server answers the same either way (it is not a registration oracle).

import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { OtpChallenge, Session } from '@sidequest/contracts';
import { tokens as t } from '../../theme/tokens';
import { metrics } from '../../platform/adaptive';
import { useT } from '../../i18n/useT';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Heading, Body, Field, PrimaryButton, Chip, Eyebrow, Notice } from '../../components/ui';
import { LegalConsent } from '../../components/LegalConsent';
import { acceptance } from '../../lib/legal';

export default function SignIn() {
  const T = useT();
  const insets = useSafeAreaInsets();
  const signedIn = useSession((s) => s.signedIn);
  const deviceId = useSession((s) => s.deviceId);
  const setLanguage = useSession((s) => s.setLanguage);
  const lang = useSession((s) => s.language);
  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<OtpChallenge | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'requester' | 'runner'>('requester');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true); setError(null);
    try { setChallenge(await api.post<OtpChallenge>('/auth/otp', { msisdn: phone })); }
    catch (e) { setError(e instanceof ApiError ? e.message : T('error.generic')); }
    finally { setBusy(false); }
  }

  async function verify() {
    if (!challenge || !agreed) return;
    setBusy(true); setError(null);
    try {
      const s = await api.post<Session>('/auth/verify', {
        challenge_id: challenge.challenge_id, code, device_id: deviceId ?? undefined, role, display_name: name.trim() || undefined,
        accept_legal: acceptance(),
      });
      await signedIn(s);
      router.replace(s.account.role === 'runner' ? '/feed' : '/home');
    } catch (e) { setError(e instanceof ApiError ? e.message : T('error.generic')); }
    finally { setBusy(false); }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior="padding">
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 56, paddingHorizontal: metrics.gutter, gap: 18, paddingBottom: 40 }}>
        <Eyebrow>Side Qwest</Eyebrow>
        <Heading size={40}>{T('auth.title')}</Heading>
        <Body size={16}>{T('auth.body')}</Body>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Chip label="English" selected={lang === 'en'} onPress={() => setLanguage('en')} />
          <Chip label="Kiswahili" selected={lang === 'sw'} onPress={() => setLanguage('sw')} />
        </View>
        {!challenge ? (
          <>
            <Field label={T('auth.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" placeholder="0722 000 111" />
            <PrimaryButton label={T('auth.send')} onPress={send} loading={busy} disabled={phone.replace(/\D/g, '').length < 9} />
          </>
        ) : (
          <>
            <Field label={T('auth.code')} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} />
            <Field label={T('auth.name')} value={name} onChangeText={setName} autoComplete="given-name" />
            <Eyebrow>{T('auth.role')}</Eyebrow>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Chip label={T('auth.role_requester')} selected={role === 'requester'} onPress={() => setRole('requester')} />
              <Chip label={T('auth.role_runner')} selected={role === 'runner'} onPress={() => setRole('runner')} />
            </View>
            <LegalConsent checked={agreed} onChange={setAgreed} />
            <PrimaryButton label={T('auth.verify')} onPress={verify} loading={busy} disabled={code.length !== 6 || !agreed}
              accessibilityLabel={agreed ? undefined : `${T('auth.verify')}. ${T('legal.required')}`} />
          </>
        )}
        {error ? <Notice>{error}</Notice> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
