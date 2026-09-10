/**
 * The interface languages Berry ships, and how a request picks one.
 *
 * Pure on purpose: `i18n/request.ts` imports it on the server and the settings
 * page imports it in the browser. The list must match `LOCALES` in
 * `server-ts/src/http/validation.ts`, which refuses anything else.
 */

export const LOCALES = ['en', 'zh-Hans', 'ja', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Cookie the request config reads; mirrors the account setting. */
export const LOCALE_COOKIE = 'berry_locale';

/** Each language named in itself, so a reader can find their own. */
export const LOCALE_NAMES: Record<Locale, string> = {
   en: 'English',
   'zh-Hans': '简体中文',
   ja: '日本語',
   ko: '한국어',
};

/** One JSON file per namespace per locale under `messages/<locale>/`. */
export const NAMESPACES = [
   'common',
   'settings',
   'shell',
   'tasks',
   'projects',
   'goals',
   'reviews',
   'agents',
   'runtimes',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export function isLocale(value: unknown): value is Locale {
   return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Cookie first (it mirrors the account), then the browser's languages in
 * order, then English. Traditional Chinese is not mapped to zh-Hans: showing
 * the wrong script is worse than showing English.
 */
export function resolveLocale(
   cookie: string | null | undefined,
   acceptLanguage: string | null | undefined
): Locale {
   if (isLocale(cookie)) return cookie;
   for (const part of (acceptLanguage ?? '').split(',')) {
      const tag = (part.split(';')[0] ?? '').trim().toLowerCase();
      if (tag === 'en' || tag.startsWith('en-')) return 'en';
      if (tag === 'ja' || tag.startsWith('ja-')) return 'ja';
      if (tag === 'ko' || tag.startsWith('ko-')) return 'ko';
      if (tag === 'zh' || tag === 'zh-cn' || tag === 'zh-sg' || tag.startsWith('zh-hans')) {
         return 'zh-Hans';
      }
   }
   return DEFAULT_LOCALE;
}
