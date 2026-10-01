// The priming card shown before the system notification prompt (permissionFlow.notifications):
// iOS gives an app one prompt per install, so it is asked only after the person chose to.
// Hidden once granted; "Not now" hides it for a week; when the OS will not ask again it
// offers Settings instead of a button that would do nothing.

import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import { tokens as t } from '../theme/tokens';
import { pushStatus, enablePush, type PushStatus } from '../lib/push';
import { secureStore } from '../platform/adaptive';
import { Card, Heading, Body, PrimaryButton, SecondaryButton } from './ui';

const SNOOZE_KEY = 'sq.notify.snoozed_until';
const WEEK = 7 * 24 * 3600 * 1000;

export function NotifyIntro({ role }: { role: 'requester' | 'runner' }) {
  const T = useT();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [snoozed, setSnoozed] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      const until = Number((await secureStore.get(SNOOZE_KEY)) ?? 0);
      const s = await pushStatus();
      if (live) { setSnoozed(Date.now() < until); setStatus(s); }
    })().catch(() => undefined);
    return () => { live = false; };
  }, []);

  if (snoozed || !status || status === 'granted' || status === 'unsupported') return null;
  const blocked = status === 'blocked';
  return (
    <Card tint>
      <Heading color={t.accentDeep}>{T('notify.title')}</Heading>
      <Body style={{ marginTop: 6 }}>
        {blocked ? T('notify.blocked') : T(role === 'runner' ? 'notify.body_runner' : 'notify.body_requester')}
      </Body>
      <PrimaryButton style={{ marginTop: 14 }} label={blocked ? T('notify.settings') : T('notify.cta')}
        onPress={async () => setStatus(await enablePush())} />
      <SecondaryButton style={{ marginTop: 8 }} label={T('notify.later')}
        onPress={async () => { await secureStore.set(SNOOZE_KEY, String(Date.now() + WEEK)); setSnoozed(true); }} />
    </Card>
  );
}
