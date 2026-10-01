// "I'm 18 or older and agree to the Terms and the Privacy Notice." A real checkbox: unticked by
// default, announced as a checkbox with its state, and the two documents open from their names.

import { Linking, Pressable, Text, View } from 'react-native';
import { tokens as t } from '../theme/tokens';
import { metrics } from '../platform/adaptive';
import { useT } from '../i18n/useT';
import { TERMS_URL, PRIVACY_URL } from '../lib/legal';

export function LegalConsent({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const T = useT();
  const link = (label: string, url: string) => (
    <Text accessibilityRole="link" onPress={() => Linking.openURL(url)} style={{ color: t.accentDeep, textDecorationLine: 'underline' }}>{label}</Text>
  );
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={T('legal.consent_a11y')}
        onPress={() => onChange(!checked)} hitSlop={10}
        style={{ width: 26, height: 26, minWidth: 26, borderRadius: 7, borderWidth: 2, borderColor: checked ? t.accent : t.textMuted,
          backgroundColor: checked ? t.accent : 'transparent', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        {checked ? <Text style={{ color: t.surface, fontFamily: t.fontBodyBold, fontSize: 15, lineHeight: 17 }}>✓</Text> : null}
      </Pressable>
      <Text style={{ flex: 1, fontFamily: t.fontBody, fontSize: 14, lineHeight: 20, color: t.textBody, minHeight: metrics.tap / 2 }}>
        {T('legal.consent_before')}{link(T('legal.terms'), TERMS_URL)}{T('legal.consent_and')}{link(T('legal.privacy'), PRIVACY_URL)}{T('legal.consent_after')}
      </Text>
    </View>
  );
}
