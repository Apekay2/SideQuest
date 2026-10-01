/* global jest */
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true } }));
// jest-expo's expo-crypto mock returns undefined; idempotency keys must be real UUIDs even here.
jest.mock('expo-crypto', () => {
  const c = require('crypto');
  return { randomUUID: () => c.randomUUID(), getRandomBytes: (n) => Uint8Array.from(c.randomBytes(n)) };
});

// Native push modules have no implementation under Jest; the app treats them as "not a device".
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'undetermined', canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'denied', canAskAgain: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[test-token-0000]' })),
  setNotificationChannelAsync: jest.fn(async () => null),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  AndroidImportance: { HIGH: 4, DEFAULT: 3, LOW: 2 },
}));
jest.mock('expo-device', () => ({ isDevice: false }));
