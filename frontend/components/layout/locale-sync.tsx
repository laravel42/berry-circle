'use client';

import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { readLocaleCookie, writeLocaleCookie } from '@/lib/i18n/client-locale';
import { useSessionStore } from '@/store/session-store';

/**
 * The account is authoritative; the cookie is what the server can read.
 * When they disagree after sign-in (a new device, a cleared cookie), copy
 * the account's choice into the cookie and re-render from the server once.
 */
export function LocaleSync() {
   const rendered = useLocale();
   const preferred = useSessionStore((state) => state.preferredLocale);
   const router = useRouter();

   useEffect(() => {
      if (!preferred || preferred === rendered) return;
      // Already written: a refresh is in flight (Preferences starts its own), or
      // the browser refuses the cookie. Refreshing again would loop forever.
      if (readLocaleCookie() === preferred) return;
      writeLocaleCookie(preferred);
      router.refresh();
   }, [preferred, rendered, router]);

   return null;
}
