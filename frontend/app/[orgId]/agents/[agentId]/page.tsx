'use client';

import AgentDetails from '@/components/common/agents/agent-details';
import AgentDetailHeader from '@/components/layout/headers/agents/detail-header';
import MainLayout from '@/components/layout/main-layout';
import { useAgentsStore } from '@/store/agents-store';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';

export default function AgentDetailPage() {
   const { agentId } = useParams<{ orgId: string; agentId: string }>();
   const agent = useAgentsStore((state) => state.getAgentById(agentId));

   return (
      <MainLayout
         header={<AgentDetailHeader agentName={agent?.name ?? 'Agent'} />}
         headersNumber={1}
      >
         {/* The open tab is a query parameter, which Next requires to sit
             under a Suspense boundary. */}
         <Suspense fallback={null}>
            <AgentDetails agentId={agentId} />
         </Suspense>
      </MainLayout>
   );
}
