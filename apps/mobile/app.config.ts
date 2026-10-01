// apps/mobile/app.config.ts
// app.json is the static config; this adds what must come from the build environment and never
// from the repo: the API origin, the EAS project id push tokens are scoped to, and the Google
// Maps key Android needs. EAS Build reads these from the profile env or EAS secrets (RELEASE.md).

import type { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...(config as ExpoConfig),
  version: process.env.APP_VERSION ?? config.version,
  ios: {
    ...config.ios,
    buildNumber: process.env.IOS_BUILD_NUMBER ?? config.ios?.buildNumber ?? '1',
  },
  android: {
    ...config.android,
    versionCode: Number(process.env.ANDROID_VERSION_CODE ?? config.android?.versionCode ?? 1),
    ...(process.env.GOOGLE_MAPS_ANDROID_API_KEY
      ? { config: { ...config.android?.config, googleMaps: { apiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY } } }
      : {}),
  },
  plugins: [...(config.plugins ?? []), ['expo-notifications', { color: '#c67139' }]],
  extra: {
    ...config.extra,
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? config.extra?.apiUrl,
    ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
  },
});
