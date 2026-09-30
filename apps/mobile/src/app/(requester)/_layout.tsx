// The requester shell. The tab list comes from adaptive.ts: iOS keeps Post as a fifth tab;
// Android drops to four and draws the FAB (screens render <PostFab/>). Same screens, same
// destinations, on both (parity design §1).

import { Tabs } from 'expo-router/js-tabs';
import { AdaptiveTabBar } from '../../components/AdaptiveTabBar';
import { requesterNav } from '../../platform/adaptive';
import { tokens as t } from '../../theme/tokens';

export default function RequesterTabs() {
  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: t.bg } }}
      tabBar={(props) => <AdaptiveTabBar {...props} visible={requesterNav.tabs} />}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="post" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="wallet" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
