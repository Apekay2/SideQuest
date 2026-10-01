// react-native-maps has no web implementation. The web build (used for development and the
// design checks) shows the same caption in a card, with a link to open the runner's position.

import { Linking, Pressable, View } from 'react-native';
import { tokens as t } from '../theme/tokens';
import { Meta } from './ui';
import type { LiveMapProps } from './LiveMap';

export function LiveMap({ runner, caption }: LiveMapProps) {
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={caption} disabled={!runner}
      onPress={() => runner && Linking.openURL(`https://www.openstreetmap.org/?mlat=${runner.lat}&mlon=${runner.lng}#map=17/${runner.lat}/${runner.lng}`)}>
      <View style={{ height: 72, borderRadius: t.radius.sunk, backgroundColor: t.surfaceSunk, alignItems: 'center', justifyContent: 'center', padding: 12 }}>
        <Meta>{caption}</Meta>
      </View>
    </Pressable>
  );
}
