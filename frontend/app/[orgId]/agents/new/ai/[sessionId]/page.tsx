'use client';

import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import NewAgentBuilder from '@/components/common/agents/new-agent-builder';
import MainLayout from '@/components/layout/main-layout';

/** A builder session with a URL, so an unfinished draft can be come back to. */
export default function ResumeAgentBuilderPage() {
   const { sessionId } = useParams<{ sessionId: string }>();
   const t = useTranslations('agentsChat.create');

   const header = (
      <div className="flex w-full flex-col gap-1 border-b px-6 py-3">
         <span className="font-medium">{t('ai')}</span>
         <p className="text-muted-foreground">{t('subtitle')}</p>
      </div>
   );

   return (
      <MainLayout header={header}>
         <div className="mx-auto w-full max-w-5xl px-6 py-6">
            <NewAgentBuilder sessionId={sessionId} />
         </div>
      </MainLayout>
   );
}
