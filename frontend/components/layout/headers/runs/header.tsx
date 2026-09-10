'use client';

import { useTranslations } from 'next-intl';

export default function Header() {
   const t = useTranslations('runtimes.header');
   const common = useTranslations('common');
   return (
      <header className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">{t('title')}</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">
               {t('description')}{' '}
               <a href="" className="text-foreground underline-offset-2 hover:underline">
                  {common('learnMore')}
               </a>
            </p>
         </div>
      </header>
   );
}
