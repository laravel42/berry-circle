'use client';

import { Button } from '@/components/ui/button';
import { useCreateWorkflowStore } from '@/store/create-workflow-store';
import { Plus } from 'lucide-react';

export default function HeaderNav() {
   const openCreateWorkflow = useCreateWorkflowStore((state) => state.openModal);
   return (
      <div className="flex h-auto w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">Automations</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">
                  Workflows that start on a trigger — a Berry event, a webhook, or by hand — and run
                  typed steps: create a task, ask an agent, wait for an approval, call a tool.
               </p>
            </div>
            <Button size="xs" variant="secondary" onClick={() => openCreateWorkflow()}>
               <Plus className="size-4" />
               New workflow
            </Button>
         </div>
      </div>
   );
}
