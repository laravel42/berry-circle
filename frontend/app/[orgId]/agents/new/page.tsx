'use client';

import { useState } from 'react';

import NewAgentBuilder from '@/components/common/agents/new-agent-builder';
import NewAgentManual from '@/components/common/agents/new-agent-manual';
import MainLayout from '@/components/layout/main-layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function NewAgentPage() {
   const [tab, setTab] = useState<'builder' | 'manual'>('builder');

   const header = (
      <div className="flex w-full flex-col gap-1 border-b px-6 py-3">
         <span className="font-medium">New agent</span>
         <p className="text-muted-foreground">Describe the agent and let the builder draft it, or set it up yourself.</p>
      </div>
   );

   return (
      <MainLayout header={header}>
         <div className="mx-auto w-full max-w-5xl px-6 py-6">
            <Tabs value={tab} onValueChange={(value) => setTab(value as 'builder' | 'manual')}>
               <TabsList>
                  <TabsTrigger value="builder">Describe it</TabsTrigger>
                  <TabsTrigger value="manual">Set it up yourself</TabsTrigger>
               </TabsList>
               <TabsContent value="builder" className="pt-4">
                  <NewAgentBuilder onUnavailable={() => setTab('manual')} />
               </TabsContent>
               <TabsContent value="manual" className="pt-4">
                  <NewAgentManual />
               </TabsContent>
            </Tabs>
         </div>
      </MainLayout>
   );
}
