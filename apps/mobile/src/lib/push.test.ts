import { errandFromNotification, pushStatus, unregisterPush, enablePush } from './push';
import { secureStore } from '../platform/adaptive';

// jest-expo's secure-store stub stores nothing; the device keystore does, so model it.
jest.mock('expo-secure-store', () => {
  const m = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => m.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { m.set(k, v); }),
    deleteItemAsync: jest.fn(async (k: string) => { m.delete(k); }),
  };
});
jest.mock('./api', () => ({ api: { post: jest.fn(async () => undefined), delete: jest.fn(async () => undefined) } }));
const { api } = jest.requireMock('./api') as { api: { post: jest.Mock; delete: jest.Mock } };

const tap = (data: Record<string, unknown>) => ({ notification: { request: { content: { data } } } }) as never;

describe('push', () => {
  test('a tap opens only a well-formed errand id', () => {
    expect(errandFromNotification(tap({ errandId: '3f9a1c2e-0000-4000-8000-000000000000' }))).toBe('3f9a1c2e-0000-4000-8000-000000000000');
    expect(errandFromNotification(tap({ errandId: '../../wallet' }))).toBeNull();
    expect(errandFromNotification(tap({}))).toBeNull();
    expect(errandFromNotification(null)).toBeNull();
  });

  test('off a real device it is unsupported, and enabling asks nothing', async () => {
    expect(await pushStatus()).toBe('unsupported');
    expect(await enablePush()).toBe('unsupported');
    expect(api.post).not.toHaveBeenCalled();
  });

  test('signing out removes this device\'s token from the API and the keystore', async () => {
    await secureStore.set('sq.push.token', 'ExponentPushToken[abcdefghijkl]');
    await unregisterPush();
    expect(api.delete).toHaveBeenCalledWith('/me/push-token', { token: 'ExponentPushToken[abcdefghijkl]' });
    expect(await secureStore.get('sq.push.token')).toBeNull();
  });
});
