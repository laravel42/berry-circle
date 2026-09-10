'use client';

import { useTranslations } from 'next-intl';

export default function HeaderNav() {
   const t = useTranslations('settings.header');
   return (
      <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
         <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
               <span className="font-medium">{t('title')}</span>
            </div>
         </div>
      </div>
   );
}
