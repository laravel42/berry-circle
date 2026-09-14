'use client';

import { CreateProjectButton } from '@/components/common/projects/create-project-button';
import { useTranslations } from 'next-intl';

export default function HeaderNav() {
   const t = useTranslations('projects.header');
   const common = useTranslations('common');
   return (
      <div className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">{t('title')}</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">
                  {t('description')}{' '}
                  <a href="" className="text-foreground underline-offset-2 hover:underline">
                     {common('learnMore')}
                  </a>
               </p>
            </div>
            <CreateProjectButton />
         </div>
      </div>
   );
}
