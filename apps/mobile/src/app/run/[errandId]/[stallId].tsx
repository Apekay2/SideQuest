// StallRun (05-ui-architecture §5.3): the runner works one stall — prices, a photo, submit.
// Price entry is optimistic; the photo uploads straight to storage on a presigned URL.

import { useEffect, useRef, useState } from 'react';
import { Image, Text, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Location from 'expo-location';
import { useQueryClient } from '@tanstack/react-query';
import { tokens as t } from '../../../theme/tokens';
import { useT } from '../../../i18n/useT';
import { kes, toMinor } from '../../../lib/money';
import { api, ApiError } from '../../../lib/api';
import { useErrand } from '../../../features/errands/hooks';
import { Screen } from '../../../components/Screen';
import { Card, Field, Heading, Meta, Notice, PrimaryButton, SecondaryButton } from '../../../components/ui';

export default function StallRun() {
  const T = useT();
  const qc = useQueryClient();
  const { errandId, stallId } = useLocalSearchParams<{ errandId: string; stallId: string }>();
  const q = useErrand(errandId);
  const stall = q.data?.stalls.find((s) => s.id === stallId);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [camera, setCamera] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);

  useEffect(() => {
    if (stall) setPrices((p) => Object.keys(p).length ? p : Object.fromEntries(stall.items.map((i) => [i.id, i.price_cents === null ? '' : String(i.price_cents / 100)])));
  }, [stall]);

  if (!q.data || !stall) return <Screen title="" back><Meta>{T('common.loading')}</Meta></Screen>;
  const items = stall.items.filter((i) => i.accepted !== false);
  const editable = stall.status === 'pending';
  const total = items.reduce((a, i) => a + (toMinor(prices[i.id] ?? '') ?? 0), 0);

  async function shoot() {
    const pic = await cam.current?.takePictureAsync({ quality: 0.6, skipProcessing: true });
    if (pic) { setPhoto(pic.uri); setCamera(false); }
  }

  async function send() {
    setBusy(true); setError(null);
    try {
      await api.post(`/errands/${errandId}/stalls/${stallId}/items`, {
        items: items.map((i) => ({ id: i.id, price_cents: toMinor(prices[i.id] ?? '') ?? 0 })),
      });
      if (photo) {
        const pos = await Location.getLastKnownPositionAsync().catch(() => null);
        const slot = await api.post<{ upload_url: string; headers: Record<string, string> }>(`/errands/${errandId}/stalls/${stallId}/evidence`, {
          kind: 'goods', content_type: 'image/jpeg', taken_at: new Date().toISOString(),
          ...(pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : {}),
        });
        await api.upload(slot.upload_url, slot.headers, photo);
      }
      await api.post(`/errands/${errandId}/stalls/${stallId}/submit`);
      qc.invalidateQueries({ queryKey: ['errand', errandId] });
      router.back();
    } catch (e) { setError(e instanceof ApiError ? e.message : T('error.generic')); }
    finally { setBusy(false); }
  }

  if (camera) {
    return (
      <View style={{ flex: 1, backgroundColor: t.ink }}>
        <CameraView ref={cam} style={{ flex: 1 }} facing="back" />
        <View style={{ position: 'absolute', left: 20, right: 20, bottom: 48 }}>
          <PrimaryButton label={T('run.photo')} onPress={shoot} />
        </View>
      </View>
    );
  }

  return (
    <Screen title={stall.name} back>
      {stall.status === 'photographed' ? <Notice tone="ok">{T('run.sent', { name: q.data.requester.display_name })}</Notice> : null}
      {stall.status === 'approved' ? <Notice tone="ok">{T('run.approved')}</Notice> : null}
      {stall.status === 'declined' ? <Notice>{T('run.declined')}</Notice> : null}
      <Card style={{ gap: 10 }}>
        <Heading>{T('run.price')}</Heading>
        {items.map((i) => (
          <Field key={i.id} label={`${i.label} · ${i.qty} ${i.unit}`} value={prices[i.id] ?? ''} editable={editable}
            keyboardType="decimal-pad" onChangeText={(v) => setPrices((p) => ({ ...p, [i.id]: v }))} />
        ))}
        <Meta>{kes(total, T.locale)}</Meta>
      </Card>
      {editable ? (
        <>
          {photo ? <Image source={{ uri: photo }} style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: t.radius.photo }} accessibilityLabel={T('stall.photo')} /> : null}
          <SecondaryButton style={{ flex: 0 }} label={photo || stall.evidence_attempts ? T('run.retake') : T('run.photo')}
            onPress={async () => { if (!perm?.granted) await requestPerm(); setCamera(true); }} />
          {error ? <Notice>{error}</Notice> : null}
          <PrimaryButton label={T('run.submit')} loading={busy}
            disabled={!photo || items.some((i) => toMinor(prices[i.id] ?? '') === null)} onPress={send} />
        </>
      ) : null}
      <Text style={{ height: 4 }} />
    </Screen>
  );
}
