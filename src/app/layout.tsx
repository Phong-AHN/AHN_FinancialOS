import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AHN Financial OS',
  description:
    'Every dollar in. Every dollar out. Cash, runway, break-even and every-dollar alerting for Asian Hustle Network.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
