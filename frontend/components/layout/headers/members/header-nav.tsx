'use client';

import { useTranslations } from 'next-intl';

/**
 * The members header.
 *
 * The "Invite" button that used to sit here opened nothing. Inviting now lives
 * in the list itself, next to the people it adds to, and only for someone who
 * may actually do it — so this header states what the page is and how many are
 * on it, and leaves the actions to the surface that can perform them.
 */
export default function HeaderNav() {
   const t = useTranslations('workspaceAdmin.members');

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
