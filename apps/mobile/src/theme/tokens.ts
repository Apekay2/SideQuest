// apps/mobile/src/theme/tokens.ts
// Generated from the Organic design system. Do not add a colour here by hand;
// add it to the theme source and regenerate, so the console stays in step.

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

  fontHeading: 'Caprasimo',
  fontBody: 'Figtree',

  size: { eyebrow: 11, meta: 12, body: 13.5, button: 15, title: 17, hero: 22 },
  radius: { sunk: 20, sheet: 22, card: 28, pill: 999 },
  space: { gutter: 20, card: 12, inner: 10 },
  tap: 44,
} as const;

export type Tokens = typeof tokens;
