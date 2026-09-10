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
      'Berry — a team workspace where humans and AI coding agents share one board. Tasks, projects, cycles and review gates in one place.',
};

import { ThemeProvider } from '@/components/layout/theme-provider';
import { SessionGate } from '@/components/layout/session-gate';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';

export default async function RootLayout({
   children,
}: Readonly<{
   children: React.ReactNode;
}>) {
   const locale = await getLocale();
   return (
      <html lang={locale} suppressHydrationWarning>
         <body
            className={`${dmSerifDisplay.variable} ${geistMono.variable} bg-background antialiased`}
            suppressHydrationWarning
         >
            <NextIntlClientProvider>
               <NuqsAdapter>
                  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
                     <SessionGate>
                        {children}
                        <Toaster />
                     </SessionGate>
                  </ThemeProvider>
               </NuqsAdapter>
            </NextIntlClientProvider>
         </body>
      </html>
   );
}
