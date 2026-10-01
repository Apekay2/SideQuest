// The runner's four tabs are the same on both platforms: there is no create action on this
// side, so no FAB and no fifth tab (adaptive.ts runnerNav).

import { Tabs } from 'expo-router/js-tabs';
import { AdaptiveTabBar } from '../../components/AdaptiveTabBar';
import { runnerNav } from '../../platform/adaptive';
import { tokens as t } from '../../theme/tokens';

export default function RunnerTabs() {
  return (
    <Tabs screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: t.bg } }}
      tabBar={(props) => <AdaptiveTabBar {...props} visible={runnerNav.tabs.map((n) => (n === 'profile' ? 'me' : n))} />}>
      <Tabs.Screen name="feed" />
      <Tabs.Screen name="active" />
      <Tabs.Screen name="earnings" />
      {/* Named `me` because `profile` is the requester group's route; the bar labels it Profile. */}
      <Tabs.Screen name="me" />
    </Tabs>
  );
}
