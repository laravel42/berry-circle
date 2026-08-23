'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useAgentsStore } from '@/store/agents-store';

export default function HeaderNav() {
   const { orgId } = useParams<{ orgId: string }>();
   const agents = useAgentsStore((state) => state.agents);

   return (
      <div className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-2">
               <SidebarTrigger className="mt-0.5" />
               <div className="min-w-0">
                  <div className="flex items-center gap-2">
                     <span className="text-sm font-medium">Agents</span>
                     {agents.length > 0 ? (
                        <span className="rounded-md bg-accent px-1.5 py-1 text-xs">{agents.length}</span>
                     ) : null}
                  </div>
                  <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                     AI teammates that pick up issues, comment, and update status.{' '}
                     <Link href={`/${orgId}/runs`} className="text-foreground underline-offset-2 hover:underline">
                        Learn more
                     </Link>
                  </p>
               </div>
            </div>
            <Button size="xs" variant="secondary" asChild>
               <Link href={`/${orgId}/settings/ai`}>
                  <Plus className="size-4" />
                  New agent
               </Link>
            </Button>
         </div>
      </div>
   );
}
