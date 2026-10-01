// apps/mobile/src/theme/tokens.ts
// Generated from the Organic design system. Do not add a colour here by hand;
// add it to the theme source and regenerate, so the console stays in step.
//
// Everything in this file is identical on both platforms (11-cross-platform.md §11.2). Anything
// that differs by platform lives in platform/adaptive.ts, never here.

export const tokens = {
  bg: '#f5ead8',
  surface: '#f9f4ed',
  surfaceSunk: '#ebddc5',
  border: '#dcd3c4',
  borderSoft: '#ece0ca',
  borderSunk: '#e2d5bd',
  text: '#201e1d',
  textBody: '#3b3730',
  textMuted: '#645c50',
  textFaint: '#82796a',
  accent: '#c67139',
  accentDeep: '#8c491a',
  accentTint: '#fff2eb',
  accentEdge: '#ffc6a5',
  accent2: '#7a8a5e',
  /** Unfilled progress segment on the live card. */
  track: '#e2d5bd',
  scrim: 'rgba(32,30,29,0.55)',
  scrimConfirm: 'rgba(32,30,29,0.5)',
  ink: '#201e1d',

  // Caprasimo for headings and button labels, Figtree for everything else, on both platforms.
  // Android cannot synthesise a weight for a custom family, so each weight is its own family.
  fontHeading: 'Caprasimo_400Regular',
  fontBody: 'Figtree_400Regular',
  fontBodyMedium: 'Figtree_500Medium',
  fontBodySemi: 'Figtree_600SemiBold',
  fontBodyBold: 'Figtree_700Bold',

  size: { eyebrow: 11, meta: 12, body: 13.5, button: 15, title: 17, hero: 22, screen: 26 },
  radius: { sunk: 20, sheet: 22, card: 28, photo: 26, pill: 999 },
  space: { gutter: 20, card: 12, inner: 10 },
  /** The accessibility floor, stricter of the two platforms, applied on both (§11.5). */
  tap: 48,
} as const;

export type Tokens = typeof tokens;
