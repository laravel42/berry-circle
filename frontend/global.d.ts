import type messages from '@/i18n/messages-en';
import type { Locale } from '@/lib/i18n/locales';

declare module 'next-intl' {
   interface AppConfig {
      Locale: Locale;
      Messages: typeof messages;
   }
}
