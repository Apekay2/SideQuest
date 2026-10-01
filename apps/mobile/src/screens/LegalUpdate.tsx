// Shown over the whole app when the terms or privacy notice changed since this person last
// accepted (Me.legal_current false, or an action refused with LEGAL_ACCEPTANCE_REQUIRED).
// Reading still works underneath on the server; this screen makes the choice explicit. SOS
// stays reachable from a live errand regardless (the API never blocks it).

import { useState } from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tokens as t } from '../theme/tokens';
import { metrics } from '../platform/adaptive';
import { useT } from '../i18n/useT';
import { api, ApiError, refresh } from '../lib/api';
import { acceptance } from '../lib/legal';
import { useSession } from '../lib/session';
import { LegalConsent } from '../components/LegalConsent';
import { Eyebrow, Heading, Body, PrimaryButton, SecondaryButton, Notice } from '../components/ui';

export function LegalUpdate() {
  const T = useT();
  const insets = useSafeAreaInsets();
  const signOut = useSession((s) => s.signOut);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true); setError(null);
    try {
      await api.post('/me/legal', acceptance());
      await refresh();   // a new access token carries the acceptance; Me.legal_current turns true
    } catch (e) { setError(e instanceof ApiError ? e.message : T('error.generic')); }
    finally { setBusy(false); }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ paddingTop: insets.top + 56, paddingHorizontal: metrics.gutter, gap: 18, paddingBottom: 40 }}>
      <Eyebrow>Side Qwest</Eyebrow>
      <Heading size={32} accessibilityRole="header">{T('legal.update_title')}</Heading>
      <Body size={16}>{T('legal.update_body')}</Body>
      <LegalConsent checked={checked} onChange={setChecked} />
      <PrimaryButton label={T('legal.update_accept')} onPress={accept} loading={busy} disabled={!checked} />
      <SecondaryButton label={T('legal.update_decline')} onPress={() => signOut()} />
      {error ? <Notice>{error}</Notice> : null}
    </ScrollView>
  );
}
