// Verification. Documents go from the camera straight to storage on a five-minute presigned
// URL; tier 3 (runners carrying a card) adds the conduct certificate, next of kin and consent
// to share location while on an errand.

import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useQueryClient } from '@tanstack/react-query';
import type { KycCase, Presigned } from '@sidequest/contracts';
import { tokens as t } from '../theme/tokens';
import { useT, type Key } from '../i18n/useT';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { useKyc } from '../features/errands/hooks';
import { Screen } from '../components/Screen';
import { Chip, Field, Notice, PrimaryButton, SunkRow, Body, Meta } from '../components/ui';

type Slot = 'id_front' | 'id_back' | 'selfie' | 'conduct_cert';

export default function Kyc() {
  const T = useT();
  const qc = useQueryClient();
  const me = useSession((s) => s.account);
  const existing = useKyc();
  const [kase, setKase] = useState<KycCase | null>(null);
  const [shooting, setShooting] = useState<Slot | null>(null);
  const [idNumber, setIdNumber] = useState('');
  const [kinName, setKinName] = useState('');
  const [kinPhone, setKinPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [perm, request] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const target = me?.role === 'runner' ? 3 : 2;

  useEffect(() => {
    if (existing.data?.status === 'unsubmitted') setKase(existing.data);
  }, [existing.data]);

  async function ensureCase(): Promise<KycCase> {
    if (kase) return kase;
    const c = await api.post<KycCase>('/kyc/cases', { target_tier: target });
    setKase(c);
    return c;
  }

  async function capture() {
    if (!shooting) return;
    const slot = shooting;
    const pic = await cam.current?.takePictureAsync({ quality: 0.7 });
    setShooting(null);
    if (!pic) return;
    setBusy(true);
    try {
      const c = await ensureCase();
      const p = await api.post<Presigned>(`/kyc/cases/${c.id}/documents`, { slot, content_type: 'image/jpeg' });
      await api.upload(p.upload_url, p.headers, pic.uri);
      setKase({ ...c, slots: { ...c.slots, [slot]: true } });
    } catch (e) { setError(e instanceof ApiError ? e.message : T('error.generic')); }
    finally { setBusy(false); }
  }

  async function submit() {
    if (!kase) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/kyc/cases/${kase.id}/submit`, {
        id_number: idNumber || undefined,
        ...(target === 3 ? { next_of_kin: { name: kinName, msisdn: kinPhone }, movement_consent: consent } : {}),
      });
      qc.invalidateQueries({ queryKey: ['kyc'] });
      router.back();
    } catch (e) { setError(e instanceof ApiError ? e.message : T('error.generic')); }
    finally { setBusy(false); }
  }

  if (shooting) {
    return (
      <View style={{ flex: 1, backgroundColor: t.ink }}>
        <CameraView ref={cam} style={{ flex: 1 }} facing={shooting === 'selfie' ? 'front' : 'back'} />
        <View style={{ position: 'absolute', left: 20, right: 20, bottom: 48 }}>
          <PrimaryButton label={T('kyc.capture')} onPress={capture} />
        </View>
      </View>
    );
  }

  const slots: Slot[] = target === 3 ? ['id_front', 'id_back', 'selfie', 'conduct_cert'] : ['id_front', 'id_back', 'selfie'];
  const done = (s: Slot) => Boolean(kase?.slots[s]);
  return (
    <Screen title={T('kyc.title')} back>
      <Body>{T('home.verify_body')}</Body>
      {slots.map((s) => (
        <SunkRow key={s} onPress={async () => { if (!perm?.granted) await request(); setShooting(s); }} accessibilityLabel={T(`kyc.${s}` as Key)}>
          <Body color={t.text}>{T(`kyc.${s}` as Key)}</Body>
          <Meta color={done(s) ? t.accent2 : t.accentDeep}>{done(s) ? T('kyc.captured') : T('kyc.capture')}</Meta>
        </SunkRow>
      ))}
      <Field label={T('kyc.id_number')} value={idNumber} onChangeText={setIdNumber} keyboardType="number-pad" />
      {target === 3 ? (
        <>
          <Field label={T('kyc.kin_name')} value={kinName} onChangeText={setKinName} />
          <Field label={T('kyc.kin_phone')} value={kinPhone} onChangeText={setKinPhone} keyboardType="phone-pad" />
          <Chip label={T('kyc.consent')} selected={consent} onPress={() => setConsent(!consent)} />
        </>
      ) : null}
      {error ? <Notice>{error}</Notice> : null}
      <PrimaryButton label={T('kyc.submit')} loading={busy}
        disabled={!kase || slots.some((s) => !done(s)) || !idNumber || (target === 3 && (!kinName || !kinPhone || !consent))}
        onPress={submit} />
    </Screen>
  );
}
