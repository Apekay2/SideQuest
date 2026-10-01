// The runner's live position and the drop-off, on the requester's live view. Only verified
// fixes reach here (useLink drops any whose HMAC tag fails), so the pin is the runner's own
// phone, not a server's say-so. Apple Maps on iOS, Google Maps on Android (key in app.config).

import MapView, { Marker } from 'react-native-maps';
import { View } from 'react-native';
import { tokens as t } from '../theme/tokens';
import { regionFor, type Point } from '../lib/geo';

export interface LiveMapProps { runner: Point | null; dropoff: Point; runnerLabel: string; dropoffLabel: string; caption: string }

export function LiveMap({ runner, dropoff, runnerLabel, dropoffLabel, caption }: LiveMapProps) {
  const region = regionFor(runner ? [runner, dropoff] : [dropoff]);
  return (
    // The map itself is not navigable by screen readers in a useful way; the caption (distance
    // and freshness, also shown as text below) is what is announced.
    <View accessible accessibilityLabel={caption} style={{ height: 190, borderRadius: t.radius.sunk, overflow: 'hidden' }}>
      <MapView style={{ flex: 1 }} region={region} pitchEnabled={false} rotateEnabled={false} toolbarEnabled={false}
        importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Marker coordinate={{ latitude: dropoff.lat, longitude: dropoff.lng }} title={dropoffLabel} pinColor={t.accent2} />
        {runner ? <Marker coordinate={{ latitude: runner.lat, longitude: runner.lng }} title={runnerLabel} pinColor={t.accent} /> : null}
      </MapView>
    </View>
  );
}
