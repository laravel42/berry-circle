'use client';

import AgentDetails from '@/components/common/agents/agent-details';
import AgentDetailHeader from '@/components/layout/headers/agents/detail-header';
import MainLayout from '@/components/layout/main-layout';
import { useAgentsStore } from '@/store/agents-store';
import { useParams } from 'next/navigation';

export default function AgentDetailPage() {
   const { agentId } = useParams<{ orgId: string; agentId: string }>();
   const agent = useAgentsStore((state) => state.getAgentById(agentId));

   return (
      <MainLayout header={<AgentDetailHeader agentName={agent?.name ?? 'Agent'} />} headersNumber={1}>
         <AgentDetails agentId={agentId} />
      </MainLayout>
   );
}
