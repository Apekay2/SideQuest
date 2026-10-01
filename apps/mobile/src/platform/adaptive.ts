// apps/mobile/src/platform/adaptive.ts
// The single place where the two platforms are allowed to differ. Every other file in the
// app imports from here rather than calling Platform.select inline — that is what keeps
// "brand shared, chrome native" true over time instead of true on the day it was written.
//
// The rule this file enforces: a platform difference is legitimate when it matches a
// convention the user's thumb already knows (where a create action lives, how a sheet is
// dismissed, what a press feels like) and illegitimate when it changes what the product
// says or the order it says it in. Anything in the second category belongs in the shared
// component, not here.

import { useEffect, useState } from 'react';
import { Platform, AccessibilityInfo, BackHandler } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';

export const isIOS = Platform.OS === 'ios';
export const isAndroid = Platform.OS === 'android';

/** Pick per platform with both branches required, so adding a case cannot silently fall
 *  through to a default that was only ever right for iOS. */
export function pick<T>(options: { ios: T; android: T }): T {
  return isIOS ? options.ios : options.android;
}

// ─────────────────────────────────────────────── metrics

export const metrics = {
  /**
   * Minimum tap target for rows. The parity design draws 44pt rows on iOS and 48dp on
   * Android — each platform's own floor — while §11.5 sets 48 as the accessibility floor for
   * every CONTROL on both. Rows follow the drawing; hit areas never go below `hitFloor`.
   */
  tap: pick({ ios: 44, android: 48 }),

  /** §11.5: the stricter of the two platforms, applied everywhere a finger lands. */
  hitFloor: 48,

  /** Secondary action height on the approval sheet (Substitute / Decline). */
  secondaryButtonHeight: pick({ ios: 44, android: 48 }),

  /** Large title in the header. */
  titleSize: pick({ ios: 30, android: 28 }),

  /** Avatar in the header's trailing slot. */
  avatar: pick({ ios: 36, android: 40 }),

  /** Home indicator reserve under the iOS tab bar is the safe-area inset; Android has none. */
  sheetBottomPad: pick({ ios: 34, android: 12 }),

  /** Primary button height. Material's filled button is taller; matching it keeps the
   *  Approve button feeling native without changing its position or label. */
  primaryButtonHeight: pick({ ios: 52, android: 56 }),

  /** Screen gutter. 20 on iOS, 16 on Android — Material's own baseline grid. */
  // Also used as the sheet's horizontal padding (design: 20 / 16).
  gutter: pick({ ios: 20, android: 16 }),

  /** Bottom sheet corner radius. 26 vs M3's 28. */
  sheetRadius: pick({ ios: 26, android: 28 }),

  /** The sheet's drag affordance. iOS grabber is 44×5; M3's handle is 32×4. */
  sheetHandle: pick({ ios: { width: 44, height: 5 }, android: { width: 32, height: 4 } }),

  /** Tab bar height, excluding safe-area inset. */
  tabBarHeight: pick({ ios: 49, android: 80 }),

  /** Secondary label size in the tab bar. Both are platform minimums for legibility. */
  tabLabelSize: pick({ ios: 10, android: 12 }),

  /**
   * Sheet rise. 280ms on iOS matches the platform's own modal timing; Material's emphasised
   * easing runs a little longer. Both are overridden to 0 under reduce-motion.
   */
  sheetDuration: pick({ ios: 280, android: 300 }),
  sheetEasing: pick({
    ios: 'cubic-bezier(.2,.7,.3,1)',
    android: 'cubic-bezier(.05,.7,.1,1)',   // M3 emphasised decelerate
  }),
} as const;

// ─────────────────────────────────────────────── navigation shape

/**
 * The requester's primary create action.
 *
 * iOS: a fifth tab, because iOS users look for creation in the tab bar.
 * Android: four tabs and a FAB, because Material users look for it bottom-right.
 *
 * Same destination, same screen, same one-thumb reach. This is the most visible platform
 * difference in the app and the one most likely to be "fixed" by someone unifying the two —
 * hence the comment rather than a bare flag.
 */
export const requesterNav = pick({
  ios: {
    tabs: ['home', 'post', 'activity', 'wallet', 'profile'] as const,
    createAs: 'tab' as const,
  },
  android: {
    tabs: ['home', 'activity', 'wallet', 'profile'] as const,
    createAs: 'fab' as const,
  },
});

/** The runner's four tabs are the same on both: there is no create action on that side. */
export const runnerNav = {
  tabs: ['feed', 'active', 'earnings', 'profile'] as const,
  createAs: 'none' as const,
};

/** Header title placement. iOS large title collapsing to a centred inline title; Android
 *  M3 large top app bar that stays left-aligned. */
export const headerStyle = pick({
  ios: { align: 'left' as const, collapseTo: 'center' as const, size: 30, backLabel: true },
  android: { align: 'left' as const, collapseTo: 'left' as const, size: 28, backLabel: false },
});

/**
 * Android's system back must be handled everywhere a sheet or modal can open. A sheet that
 * ignores back is the single most common way a cross-platform app feels broken to an
 * Android user — the gesture is muscle memory, and when nothing happens they press it again
 * and leave the app.
 *
 * On iOS this returns a no-op subscription, so callers need no conditional.
 */
export function useSystemBack(handler: () => boolean): void {
  useEffect(() => {
    if (!isAndroid) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', handler);
    return () => sub.remove();
  }, [handler]);
}

// ─────────────────────────────────────────────── feedback

/**
 * Haptics, named by MEANING rather than by intensity, so a call site cannot pick the wrong
 * one for the platform. `moneyCommitted` is deliberately the strongest signal in the set:
 * it is the only irreversible action in the product.
 */
export const haptic = {
  /** Tap on a row, a chip, a tab. */
  select: () => (isIOS
    ? Haptics.selectionAsync()
    : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),

  /** Approve pressed — before the request goes out. */
  moneyCommitted: () => Haptics.impactAsync(
    pick({ ios: Haptics.ImpactFeedbackStyle.Medium, android: Haptics.ImpactFeedbackStyle.Heavy }),
  ),

  /** Tranche loaded, stall done, payout sent. */
  success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),

  /** Card declined, over cap, upload failed. */
  problem: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
} as const;

/**
 * Press treatment. iOS dims; Android ripples. Both read from the same two brand tokens, so
 * a palette change lands on both platforms at once.
 */
export function pressable(tokens: { accent: string; accentDeep: string; surfaceSunk: string }) {
  return pick({
    ios: {
      style: ({ pressed }: { pressed: boolean }) => ({
        backgroundColor: pressed ? tokens.accent : tokens.accentDeep,
      }),
      android_ripple: undefined,
    },
    android: {
      style: () => ({ backgroundColor: tokens.accentDeep }),
      android_ripple: { color: tokens.accent, borderless: false },
    },
  });
}

// ─────────────────────────────────────────────── confirms

/**
 * A destructive confirm. iOS gets an action sheet from the bottom; Android gets a centred
 * M3 dialog with the confirming action last on the right.
 *
 * Two rules hold on both, and they are enforced here rather than left to each call site:
 * the destructive option is never the default focused action, and the scrim is not
 * dismissible — a stall decline is not something to lose by a stray tap.
 */
export interface ConfirmSpec {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** Optional middle path, e.g. "Ask for a substitute". */
  alternativeLabel?: string;
}

export const confirmPresentation = pick({
  ios: {
    kind: 'action-sheet' as const,
    /** iOS action sheets put the message above the options and Cancel in its own group. */
    order: ['body', 'confirm', 'alternative', 'cancel'] as const,
    /** Our terracotta rather than the system red: the palette carries the warning, and
     *  accentDeep on surface passes 4.5:1 at 17px. */
    destructiveColor: 'accentDeep' as const,
    dismissOnScrim: false,
    defaultFocus: null,
  },
  android: {
    kind: 'dialog' as const,
    /** M3 dialogs read headline, body, then actions bottom-right, confirm last. */
    order: ['title', 'body', 'cancel', 'confirm'] as const,
    destructiveColor: 'accentDeep' as const,
    dismissOnScrim: false,
    defaultFocus: null,
  },
});

// ─────────────────────────────────────────────── system integration

/** Notification channels are an Android concept and a real one: a runner must be able to
 *  silence chat without silencing "your card is ready". iOS gets the same separation
 *  through interruption levels. */
export const notificationChannels = [
  { id: 'money', name: 'Payments and cards', importance: 'high', iosLevel: 'timeSensitive' },
  { id: 'errand', name: 'Errand updates', importance: 'high', iosLevel: 'active' },
  { id: 'chat', name: 'Messages', importance: 'default', iosLevel: 'active' },
  { id: 'marketing', name: 'Offers', importance: 'low', iosLevel: 'passive' },
] as const;

/** The push platform this build registers as; null where there is no push (web). */
export const pushPlatform: 'ios' | 'android' | null =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : null;

/**
 * Android needs its notification channels created before the first notification arrives (the
 * worker addresses them by id); iOS has no channels, and its levels come from the payload.
 */
export async function setupNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const importance = {
    high: Notifications.AndroidImportance.HIGH,
    default: Notifications.AndroidImportance.DEFAULT,
    low: Notifications.AndroidImportance.LOW,
  } as const;
  for (const c of notificationChannels) {
    await Notifications.setNotificationChannelAsync(c.id, { name: c.name, importance: importance[c.importance] });
  }
}

/**
 * Permission priming. Both platforms punish a cold request, differently: iOS gives one
 * chance forever, Android gives two and then "don't ask again". So the in-app explanation
 * screen runs BEFORE the system prompt on both, and the copy is shared.
 */
export const permissionFlow = {
  location: { prime: true, rationaleScreen: 'MovementConsent', settingsFallback: true },
  camera: { prime: true, rationaleScreen: 'StallPhotoIntro', settingsFallback: true },
  notifications: {
    prime: true,
    rationaleScreen: 'NotifyIntro',
    /** Android 13+ needs a runtime request; earlier versions are granted at install. */
    runtimeRequired: pick({ ios: true, android: true }),
    settingsFallback: true,
  },
} as const;

/** Reduce-motion, checked once at startup and re-checked on change. Under it the approval
 *  sheet fades rather than rising, on both platforms. */
export async function prefersReducedMotion(): Promise<boolean> {
  return AccessibilityInfo.isReduceMotionEnabled();
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (live) setReduced(v); });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { live = false; sub.remove(); };
  }, []);
  return reduced;
}

// ─────────────────────────────────────────────── drawing details

/** Tab bar, drawn the way each platform draws it (parity design §1). */
export const tabBarStyle = pick({
  ios: {
    kind: 'ios' as const,
    /** Translucent surface over a blur; tint on icon and label, no indicator. */
    background: 'rgba(249,244,237,0.92)',
    paddingTop: 7,
    labelWeight: 'active-only' as const,
    inactiveColor: 'textFaint' as const,
  },
  android: {
    kind: 'android' as const,
    /** M3: 64×32 pill behind the active icon in accentEdge. */
    background: 'surface' as const,
    indicator: { width: 64, height: 32, radius: 16, color: 'accentEdge' as const },
    inactiveColor: 'textMuted' as const,
  },
});

/** The FAB. Only Android draws one (requesterNav.createAs === 'fab'). M3 large-ish, 64 dp. */
export const fab = { size: 64, radius: 20, right: 16, bottomAboveBar: 16 } as const;

/** Web previews are neither; `pick` resolves them to the Android drawing. */
export const platformLabel = pick({ ios: 'iOS', android: 'Android' });

/** Screen-reader announcement for the one state a sighted user sees as a colour change:
 *  the total going over cap. Shared copy, platform-native delivery. */
export function announce(message: string): void {
  // Deferred a frame so the announcement follows the re-render that caused it rather than
  // being cut off by it (InteractionManager is deprecated as of RN 0.86).
  setTimeout(() => AccessibilityInfo.announceForAccessibility(message), 0);
}

// ─────────────────────────────────────────────── secure storage

/**
 * Where the refresh token lives: Keychain on iOS, Keystore-backed storage on Android
 * (09-appsec: the token is never reachable from JavaScript on the web console and never in
 * plain AsyncStorage on a phone). Web previews have neither, so they keep it in memory only
 * and sign in again on reload.
 */
const memory = new Map<string, string>();
export const secureStore = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') return memory.get(key) ?? null;
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') { memory.set(key, value); return; }
    await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  },
  async del(key: string): Promise<void> {
    if (Platform.OS === 'web') { memory.delete(key); return; }
    await SecureStore.deleteItemAsync(key);
  },
};
