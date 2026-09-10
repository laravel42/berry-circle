import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

import { LOCALE_COOKIE, NAMESPACES, resolveLocale } from '@/lib/i18n/locales';

/**
 * No locale in the URL: Berry's routes are workspace-scoped already, and a
 * language prefix would split every tab and bookmark in two. The cookie mirrors
 * the account setting (see LocaleSync), so the server renders the right
 * language on the first byte.
 */
export default getRequestConfig(async () => {
   const cookieStore = await cookies();
   const headerStore = await headers();
   const locale = resolveLocale(
      cookieStore.get(LOCALE_COOKIE)?.value,
      headerStore.get('accept-language')
   );
   const entries = await Promise.all(
      NAMESPACES.map(
         async (namespace) =>
            [namespace, (await import(`../messages/${locale}/${namespace}.json`)).default] as const
      )
   );
   return { locale, messages: Object.fromEntries(entries) };
});
