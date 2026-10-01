// Client state, one of the three Zustand slices 05-ui-architecture.md §5.4 allows: the session
// (tokens, role, language). Server state lives in react-query, never here.

import { create } from 'zustand';
import * as Crypto from 'expo-crypto';
import type { Me } from '@sidequest/contracts';
import { secureStore } from '../platform/adaptive';

const REFRESH_KEY = 'sq.refresh';
const DEVICE_KEY = 'sq.device';

interface SessionState {
  ready: boolean;
  access: string | null;
  account: Me | null;
  language: 'en' | 'sw';
  deviceId: string | null;
  hydrate(): Promise<void>;
  signedIn(s: { access: string; refresh: string; account: Me }): Promise<void>;
  setAccount(a: Me): void;
  setLanguage(l: 'en' | 'sw'): void;
  signOut(): Promise<void>;
  refreshToken(): Promise<string | null>;
}

export const useSession = create<SessionState>((set, get) => ({
  ready: false,
  access: null,
  account: null,
  language: 'en',
  deviceId: null,

  async hydrate() {
    let deviceId = await secureStore.get(DEVICE_KEY);
    if (!deviceId) {
      deviceId = Crypto.randomUUID();
      await secureStore.set(DEVICE_KEY, deviceId);
    }
    set({ deviceId, ready: true });
  },

  async signedIn({ access, refresh, account }) {
    await secureStore.set(REFRESH_KEY, refresh);
    set({ access, account, language: account.language });
  },

  setAccount(account) { set({ account, language: account.language }); },
  setLanguage(language) { set({ language }); },

  async signOut() {
    await secureStore.del(REFRESH_KEY);
    set({ access: null, account: null });
  },

  refreshToken() { return secureStore.get(REFRESH_KEY); },
}));
