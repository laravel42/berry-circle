import type { Metadata } from 'next';
import { DM_Serif_Display, Geist_Mono } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

const dmSerifDisplay = DM_Serif_Display({
   variable: '--font-dm-serif',
   subsets: ['latin'],
   weight: '400',
});

const geistMono = Geist_Mono({
   variable: '--font-geist-mono',
   subsets: ['latin'],
   weight: ['300', '400', '500', '600'],
});

export const metadata: Metadata = {
   title: {
      template: '%s | Berry',
      default: 'Berry',
   },
   description:
      'Berry — a team workspace where humans and AI coding agents share one board. Issues, projects, cycles and review gates in one place.',
};

import { ThemeProvider } from '@/components/layout/theme-provider';
import { SessionGate } from '@/components/layout/session-gate';
import { NuqsAdapter } from 'nuqs/adapters/next/app';

export default function RootLayout({
   children,
}: Readonly<{
   children: React.ReactNode;
}>) {
   return (
      <html lang="en" suppressHydrationWarning>
         <body
            className={`${dmSerifDisplay.variable} ${geistMono.variable} bg-background antialiased`}
            suppressHydrationWarning
         >
            <NuqsAdapter>
               <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
                  <SessionGate>
                     {children}
                     <Toaster />
                  </SessionGate>
               </ThemeProvider>
            </NuqsAdapter>
         </body>
      </html>
   );
}
