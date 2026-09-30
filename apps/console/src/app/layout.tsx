import type { Metadata } from 'next';
import '@fontsource/caprasimo/400.css';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Side Qwest Ops',
  robots: { index: false, follow: false },
};

// Every page reads the officer's session and live data: nothing here may be cached or prerendered
// (and the CSP nonce is per request).
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
