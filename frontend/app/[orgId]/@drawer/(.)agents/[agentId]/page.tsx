'use client';

import { useParams } from 'next/navigation';
import { Suspense } from 'react';

import AgentDetails from '@/components/common/agents/agent-details';
import DetailDrawerShell from '@/components/layout/detail-drawer-shell';
import AgentDetailHeader from '@/components/layout/headers/agents/detail-header';
import { useAgentsStore } from '@/store/agents-store';

export default function AgentDrawerPage() {
   const { agentId } = useParams<{ orgId: string; agentId: string }>();
   const agent = useAgentsStore((state) => state.getAgentById(agentId));

   return (
      <DetailDrawerShell header={<AgentDetailHeader agentName={agent?.name ?? 'Agent'} />}>
         <Suspense fallback={null}>
            <AgentDetails agentId={agentId} />
         </Suspense>
      </DetailDrawerShell>
   );
}
