'use client';

import AutopilotDialog from '@/components/common/autopilots/autopilot-dialog';
import { DeliveriesTable, RunsTable } from '@/components/common/autopilots/history-tabs';
import TriggersTab from '@/components/common/autopilots/triggers-tab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAutopilot } from '@/hooks/use-autopilot';
import {
   archiveAutopilot,
   describeAutopilotFailure,
   runAutopilot,
   updateAutopilot,
} from '@/lib/autopilots';
import { WORKSPACE_SLUG } from '@/lib/config';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

export default function AutopilotDetail({ autopilotId }: { autopilotId: string }) {
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const { autopilot, runs, deliveries, error, loading, reload } = useAutopilot(autopilotId);
   const [editing, setEditing] = useState(false);

   if (loading) return <div className="px-6 py-10 text-muted-foreground">Loading autopilot…</div>;
   if (error || !autopilot) {
      return (
         <div className="px-6 py-10 text-muted-foreground" role="alert">
            {error ?? 'This autopilot could not be loaded.'}
         </div>
      );
   }

   const act = async (work: () => Promise<unknown>, done: string) => {
      try {
         await work();
         toast.success(done);
         reload();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   };
   const paused = autopilot.status === 'paused';

   return (
      <div className="w-full">
         <div className="flex flex-wrap items-start justify-between gap-3 border-b px-6 py-4">
            <div className="min-w-0">
               <Link href={`/${orgId}/autopilots`} className="text-muted-foreground">
                  autopilots
               </Link>
               <h1 className="mt-1 font-display tracking-[-0.025em]">{autopilot.name}</h1>
               <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                  <Badge variant={paused ? 'secondary' : 'default'}>{autopilot.status}</Badge>
                  <span>v{autopilot.version}</span>
               </div>
            </div>
            <div className="flex flex-wrap gap-2">
               <Button
                  type="button"
                  onClick={() =>
                     void act(async () => {
                        const outcome = await runAutopilot(autopilot.id);
                        if (outcome.status !== 'enqueued') {
                           throw new Error(`Not queued: ${outcome.reasonCode ?? outcome.status}`);
                        }
                     }, 'Queued a run')
                  }
               >
                  run now
               </Button>
               <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                     void act(
                        () =>
                           updateAutopilot(autopilot.id, { status: paused ? 'active' : 'paused' }),
                        paused ? 'Resumed' : 'Paused'
                     )
                  }
               >
                  {paused ? 'resume' : 'pause'}
               </Button>
               <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                  edit
               </Button>
               <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                     void archiveAutopilot(autopilot.id)
                        .then(() => router.push(`/${orgId}/autopilots`))
                        .catch((failure: unknown) => toast.error(describeAutopilotFailure(failure)))
                  }
               >
                  archive
               </Button>
            </div>
         </div>

         <pre className="mx-6 mt-4 whitespace-pre-wrap rounded-md border p-3 text-muted-foreground">
            {autopilot.promptTemplate}
         </pre>

         <Tabs defaultValue="triggers" className="mt-4">
            <TabsList className="mx-6">
               <TabsTrigger value="triggers">Triggers</TabsTrigger>
               <TabsTrigger value="runs">Runs</TabsTrigger>
               <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
            </TabsList>
            <TabsContent value="triggers">
               <TriggersTab autopilot={autopilot} onChanged={reload} />
            </TabsContent>
            <TabsContent value="runs">
               <RunsTable runs={runs} orgId={orgId} />
            </TabsContent>
            <TabsContent value="deliveries">
               <DeliveriesTable
                  autopilotId={autopilot.id}
                  deliveries={deliveries}
                  onReplayed={reload}
               />
            </TabsContent>
         </Tabs>

         <AutopilotDialog
            open={editing}
            onOpenChange={(open) => {
               setEditing(open);
               if (!open) reload();
            }}
            autopilot={autopilot}
         />
      </div>
   );
}
