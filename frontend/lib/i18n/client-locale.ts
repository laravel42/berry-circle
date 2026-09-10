import { LOCALE_COOKIE, type Locale } from './locales';

/** A year: the account is authoritative, the cookie only saves a round trip. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function writeLocaleCookie(locale: Locale): void {
   document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${MAX_AGE_SECONDS}; samesite=lax`;
}

export function readLocaleCookie(): string | undefined {
   for (const part of document.cookie.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === LOCALE_COOKIE) return rest.join('=');
   }
   return undefined;
}
