/* global jest */
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-router', () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true } }));
// jest-expo's expo-crypto mock returns undefined; idempotency keys must be real UUIDs even here.
jest.mock('expo-crypto', () => {
  const c = require('crypto');
  return { randomUUID: () => c.randomUUID(), getRandomBytes: (n) => Uint8Array.from(c.randomBytes(n)) };
});
