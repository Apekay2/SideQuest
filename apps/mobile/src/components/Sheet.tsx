// apps/mobile/src/components/Sheet.tsx
// The bottom sheet both platforms draw for the approval screen, with only the feel adapted:
//   iOS      44×5 grabber, radius 26, rises 280ms cubic-bezier(.2,.7,.3,1), swipe down to close
//   Android  32×4 handle, radius 28, rises 300ms M3 emphasised decelerate, system back closes
// Under reduce-motion it fades instead of rising, on both (§11.5).

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, PanResponder, Pressable, View, useWindowDimensions } from 'react-native';
import { tokens as t } from '../theme/tokens';
import { metrics, useReducedMotion, useSystemBack, isAndroid } from '../platform/adaptive';

const EASE = isAndroid ? Easing.bezier(0.05, 0.7, 0.1, 1) : Easing.bezier(0.2, 0.7, 0.3, 1);

export function Sheet({ children, onClose, dismissible = true, bottomInset }: {
  children: ReactNode; onClose: () => void; dismissible?: boolean; bottomInset: number;
}) {
  const reduced = useReducedMotion();
  const { height } = useWindowDimensions();
  const rise = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(rise, { toValue: 1, duration: metrics.sheetDuration, easing: EASE, useNativeDriver: true }).start();
  }, [rise]);

  const close = useCallback(() => {
    if (!dismissible) return true;
    Animated.timing(rise, { toValue: 0, duration: reduced ? 150 : 220, easing: Easing.in(Easing.quad), useNativeDriver: true })
      .start(() => onClose());
    return true;
  }, [dismissible, onClose, reduced, rise]);

  // A sheet that ignores Android's back gesture feels broken to half your users (§11.3).
  useSystemBack(close);

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderRelease: (_e, g) => { if (g.dy > 80 || g.vy > 1) close(); },
  })).current;

  const translateY = reduced ? 0 : rise.interpolate({ inputRange: [0, 1], outputRange: [height * 0.6, 0] });
  const handle = metrics.sheetHandle;

  return (
    <View style={{ flex: 1, justifyContent: 'flex-end' }}>
      <Animated.View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.scrim, opacity: rise }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" style={{ flex: 1 }} onPress={close} disabled={!dismissible} />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        style={{
          backgroundColor: t.surface, borderTopLeftRadius: metrics.sheetRadius, borderTopRightRadius: metrics.sheetRadius,
          paddingBottom: bottomInset, maxHeight: isAndroid ? '90%' : '88%',
          opacity: reduced ? rise : 1, transform: [{ translateY }],
        }}
      >
        <View {...pan.panHandlers} style={{ alignItems: 'center', paddingTop: isAndroid ? 12 : 10, paddingBottom: 4 }}>
          <View accessibilityElementsHidden style={{ width: handle.width, height: handle.height, borderRadius: 999, backgroundColor: t.border }} />
        </View>
        {children}
      </Animated.View>
    </View>
  );
}
