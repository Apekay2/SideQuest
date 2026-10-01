// apps/mobile/src/components/icons.tsx
// The icon set drawn in the parity design, path for path. 24×24, 1.9 stroke, round caps.

import Svg, { Path, Rect, Circle } from 'react-native-svg';

interface P { color: string; size?: number; strokeWidth?: number }

export const HomeIcon = ({ color, size = 24, strokeWidth = 1.9 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M3 10.5 12 3l9 7.5" /><Path d="M5.5 9.5V20h13V9.5" />
  </Svg>
);
export const PlusIcon = ({ color, size = 24, strokeWidth = 1.9 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Path d="M12 5v14M5 12h14" />
  </Svg>
);
export const ActivityIcon = ({ color, size = 24, strokeWidth = 1.9 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round">
    <Path d="M4 7h16M4 12h16M4 17h10" />
  </Svg>
);
export const WalletIcon = ({ color, size = 24, strokeWidth = 1.9 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Rect x="3" y="6.5" width="18" height="12" rx="3" /><Path d="M16 12.5h2" />
  </Svg>
);
export const ProfileIcon = ({ color, size = 24, strokeWidth = 1.9 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="12" cy="8.5" r="3.5" /><Path d="M5 20c1.8-3.4 4.2-5 7-5s5.2 1.6 7 5" />
  </Svg>
);
export const FeedIcon = ({ color, size = 24, strokeWidth = 1.9 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><Circle cx="12" cy="10" r="2.3" />
  </Svg>
);
export const ActiveIcon = ({ color, size = 24, strokeWidth = 1.9 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="12" cy="12" r="8.5" /><Path d="M12 7.5V12l3 2" />
  </Svg>
);
export const BackChevron = ({ color, size = 24, strokeWidth = 2.2 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M15 5 8 12l7 7" />
  </Svg>
);
export const BackArrow = ({ color, size = 24, strokeWidth = 2 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M20 12H5M11 5l-7 7 7 7" />
  </Svg>
);
/** State icons: never colour alone (§11.2). */
export const CheckIcon = ({ color, size = 16, strokeWidth = 2.2 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="m5 12.5 4.5 4.5L19 7" />
  </Svg>
);
export const AlertIcon = ({ color, size = 16, strokeWidth = 2.2 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" /><Path d="M12 10v4M12 17h.01" />
  </Svg>
);
export const ClockIcon = ActiveIcon;
