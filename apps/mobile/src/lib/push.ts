// apps/mobile/src/lib/push.ts
// Push registration. The token goes to the API (POST /me/push-token); the worker sends through
// Expo's push service to it. Asking is never cold: NotifyIntro explains first (permissionFlow
// in platform/adaptive.ts), because iOS allows one system prompt per install.

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Linking } from 'react-native';
import { api } from './api';
import { pushPlatform, setupNotificationChannels, secureStore } from '../platform/adaptive';

export type PushStatus = 'unsupported' | 'undetermined' | 'granted' | 'denied' | 'blocked';

const TOKEN_KEY = 'sq.push.token';

// A notification arriving while the app is open: show it (the socket updates the screen too,
// but a banner is how someone looking at another tab learns their stall was photographed).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

/** The EAS project id the token is scoped to. Absent until `eas init` has run (see RELEASE.md). */
function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

export async function pushStatus(): Promise<PushStatus> {
  if (!pushPlatform || !Device.isDevice) return 'unsupported';
  const p = await Notifications.getPermissionsAsync();
  if (p.granted) return 'granted';
  if (p.status === 'undetermined') return 'undetermined';
  return p.canAskAgain ? 'denied' : 'blocked';
}

/** Register this device with the API. Safe to call on every launch; the API upserts. */
export async function registerPush(): Promise<boolean> {
  if ((await pushStatus()) !== 'granted') return false;
  const id = projectId();
  if (!id) {
    console.warn('push: no EAS projectId in app config; run `eas init` (RELEASE.md)');
    return false;
  }
  await setupNotificationChannels();
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
  await api.post('/me/push-token', { token, platform: pushPlatform });
  await secureStore.set(TOKEN_KEY, token);
  return true;
}

/** The primed request: called from NotifyIntro's button, never on its own. */
export async function enablePush(): Promise<PushStatus> {
  const before = await pushStatus();
  if (before === 'unsupported') return before;
  if (before === 'blocked') { await Linking.openSettings(); return before; }
  if (before !== 'granted') await Notifications.requestPermissionsAsync();
  const after = await pushStatus();
  if (after === 'granted') await registerPush().catch(() => false);
  return after;
}

/** Signing out: this device stops receiving the account's notifications. */
export async function unregisterPush(): Promise<void> {
  const token = await secureStore.get(TOKEN_KEY);
  if (!token) return;
  await api.delete('/me/push-token', { token }).catch(() => undefined);
  await secureStore.del(TOKEN_KEY);
}

/** The errand a tapped notification is about, if any. */
export function errandFromNotification(r: Notifications.NotificationResponse | null): string | null {
  const id = r?.notification.request.content.data?.errandId;
  return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}
