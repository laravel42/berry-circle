'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { ChevronRight } from 'lucide-react';

interface AgentDetailHeaderProps {
   agentName: string;
}

export default function AgentDetailHeader({ agentName }: AgentDetailHeaderProps) {
   const { orgId } = useParams<{ orgId: string }>();

   return (
      <div className="flex h-10 w-full items-center gap-2 border-b px-6 py-1.5">
         <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">
            <Link
               href={`/${orgId}/agents`}
               className="text-muted-foreground transition-colors hover:text-foreground"
            >
               Agents
            </Link>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate font-medium">{agentName}</span>
         </nav>
      </div>
   );
}
