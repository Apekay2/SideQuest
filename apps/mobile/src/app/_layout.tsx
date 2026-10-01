// apps/mobile/src/app/_layout.tsx
// Root: fonts, session restore, server-state cache, realtime, and the navigation graph —
// identical on both platforms (§11.2); only its presentation adapts.

import { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router/stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts, Caprasimo_400Regular } from '@expo-google-fonts/caprasimo';
import { Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold } from '@expo-google-fonts/figtree';
import { tokens as t } from '../theme/tokens';
import { useSession } from '../lib/session';
import { restoreSession, isNetworkError } from '../lib/api';
import { startRealtime } from '../lib/realtime';

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, e) => n < 2 && isNetworkError(e), staleTime: 30_000 },
    mutations: { retry: false },
  },
});

export default function Root() {
  const [fonts] = useFonts({ Caprasimo_400Regular, Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold, Figtree_700Bold });
  const hydrate = useSession((s) => s.hydrate);
  const access = useSession((s) => s.access);
  const [restored, setRestored] = useState(false);

  useEffect(() => { hydrate().then(() => restoreSession()).finally(() => setRestored(true)); }, [hydrate]);
  useEffect(() => (access ? startRealtime(qc) : undefined), [access]);

  if (!fonts || !restored) {
    return <View style={{ flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={t.accent} /></View>;
  }
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={qc}>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(requester)" />
          <Stack.Screen name="(runner)" />
          {/* An errand in flight is a mode, not a place (§5.2): a full-screen modal. */}
          <Stack.Screen name="errand/[id]" options={{ presentation: 'fullScreenModal' }} />
          {/* The sheet draws its own scrim and rise, so the route itself is transparent and still. */}
          <Stack.Screen name="stall/[errandId]/[stallId]" options={{ presentation: 'transparentModal', animation: 'none', contentStyle: { backgroundColor: 'transparent' } }} />
          <Stack.Screen name="run/[errandId]/[stallId]" />
          <Stack.Screen name="scan/[errandId]" options={{ presentation: 'fullScreenModal' }} />
          <Stack.Screen name="chat/[id]" />
          <Stack.Screen name="kyc" />
        </Stack>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
