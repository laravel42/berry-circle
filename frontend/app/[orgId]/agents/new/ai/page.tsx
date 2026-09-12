'use client';

import { useTranslations } from 'next-intl';

import NewAgentBuilder from '@/components/common/agents/new-agent-builder';
import MainLayout from '@/components/layout/main-layout';

/**
 * A builder session that has not started yet.
 *
 * The session is created by the first turn rather than by opening the page, so
 * arriving here and changing your mind leaves nothing behind to clean up. Once
 * it exists the builder replaces this URL with `/agents/new/ai/<id>`.
 */
export default function NewAgentBuilderPage() {
   const t = useTranslations('agentsChat.create');

   const header = (
      <div className="flex w-full flex-col gap-1 border-b px-6 py-3">
         <span className="font-medium">{t('ai')}</span>
         <p className="text-muted-foreground">{t('aiPromptFirst')}</p>
      </div>
   );

   return (
      <MainLayout header={header}>
         <div className="mx-auto w-full max-w-5xl px-6 py-6">
            <NewAgentBuilder sessionId={null} />
         </div>
      </MainLayout>
   );
}
