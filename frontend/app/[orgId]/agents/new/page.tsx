'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import NewAgentManual from '@/components/common/agents/new-agent-manual';
import MainLayout from '@/components/layout/main-layout';
import { Button } from '@/components/ui/button';

/**
 * Two ways to make an agent: describe it, or set it up.
 *
 * The AI builder is a route of its own (`/agents/new/ai`) rather than a tab,
 * because a builder session is a thing with a lifetime — it can be left and
 * come back to — and a tab cannot be linked to or resumed.
 */
function NewAgentChoice() {
   const { orgId } = useParams<{ orgId: string }>();
   const t = useTranslations('agentsChat.create');
   const searchParams = useSearchParams();
   const duplicateId = searchParams?.get('duplicate') ?? null;
   const [manual, setManual] = useState(false);

   // Duplicating goes straight to the form: the drafted agent already exists
   // and the person asked for a copy of it, not for a conversation about one.
   if (manual || duplicateId) {
      return <NewAgentManual duplicateId={duplicateId} />;
   }

   return (
      <div className="flex max-w-2xl flex-col gap-4">
         <p className="text-muted-foreground">{t('subtitle')}</p>
         <div className="flex flex-wrap gap-3">
            <Button size="sm" asChild>
               <Link href={`/${orgId}/agents/new/ai`}>{t('ai')}</Link>
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setManual(true)}>
               {t('manual')}
            </Button>
         </div>
      </div>
   );
}

export default function NewAgentPage() {
   const t = useTranslations('agentsChat.create');

   const header = (
      <div className="flex w-full flex-col gap-1 border-b px-6 py-3">
         <span className="font-medium">{t('title')}</span>
         <p className="text-muted-foreground">{t('subtitle')}</p>
      </div>
   );

   return (
      <MainLayout header={header}>
         <div className="mx-auto w-full max-w-5xl px-6 py-6">
            {/* `?duplicate=` is a query parameter, which Next requires to sit
                under a Suspense boundary. */}
            <Suspense fallback={null}>
               <NewAgentChoice />
            </Suspense>
         </div>
      </MainLayout>
   );
}
