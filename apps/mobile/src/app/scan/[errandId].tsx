// The runner scans the requester's rotating QR: the scan releases the task (04-api.md).

import { useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useQueryClient } from '@tanstack/react-query';
import { tokens as t } from '../../theme/tokens';
import { haptic } from '../../platform/adaptive';
import { useT } from '../../i18n/useT';
import { api, ApiError } from '../../lib/api';
import { Notice, PrimaryButton, SecondaryButton, Heading } from '../../components/ui';

export default function Scan() {
  const T = useT();
  const qc = useQueryClient();
  const { errandId } = useLocalSearchParams<{ errandId: string }>();
  const [perm, request] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCode(data: string) {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/errands/${errandId}/handover`, { qr_token: data });
      haptic.success();
      qc.invalidateQueries({ queryKey: ['errand', errandId] });
      router.replace('/earnings');
    } catch (e) { haptic.problem(); setError(e instanceof ApiError ? e.message : T('error.generic')); setBusy(false); }
  }

  if (!perm?.granted) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, padding: 24, justifyContent: 'center', gap: 16 }}>
        <Heading size={22}>{T('active.scan')}</Heading>
        <PrimaryButton label={T('kyc.capture')} onPress={request} />
        <SecondaryButton style={{ flex: 0 }} label={T('common.cancel')} onPress={() => router.back()} />
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: t.ink }}>
      <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={busy ? undefined : ({ data }) => onCode(data)} />
      <View style={{ position: 'absolute', left: 20, right: 20, bottom: 48, gap: 12 }}>
        {error ? <Notice>{error}</Notice> : null}
        <SecondaryButton style={{ flex: 0, backgroundColor: t.surface }} label={T('common.cancel')} onPress={() => router.back()} />
      </View>
    </View>
  );
}
