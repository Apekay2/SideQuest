// The published terms and privacy notice, and the versions this build asks people to accept.
// Versions come from the shared contracts so the app and the API can never disagree.

import { LEGAL_VERSIONS } from '@sidequest/contracts';

export const TERMS_URL = process.env.EXPO_PUBLIC_TERMS_URL ?? 'https://sidequest.co.ke/terms';
export const PRIVACY_URL = process.env.EXPO_PUBLIC_PRIVACY_URL ?? 'https://sidequest.co.ke/privacy';

/** The body the API expects wherever acceptance is given. */
export const acceptance = () => ({ ...LEGAL_VERSIONS, adult: true as const });
