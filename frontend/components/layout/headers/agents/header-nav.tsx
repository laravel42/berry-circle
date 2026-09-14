'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

export default function HeaderNav() {
   const { orgId } = useParams<{ orgId: string }>();
   const t = useTranslations('agents.header');
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
            <Button size="xs" variant="secondary" asChild>
               <Link href={`/${orgId}/agents/new`}>
                  <Plus className="size-4" />
                  {t('newAgent')}
               </Link>
            </Button>
         </div>
      </div>
   );
}
