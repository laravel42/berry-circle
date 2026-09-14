'use client';

import { useTranslations } from 'next-intl';

/**
 * Goals list header. No action, deliberately: planning is what makes a goal and
 * it starts in a project, so the button lives there. Offering it here would
 * invite a goal with no project to hang off.
 */
export default function Header() {
   const t = useTranslations('goals.header');
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">{t('title')}</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">{t('description')}</p>
         </div>
      </header>
   );
}
