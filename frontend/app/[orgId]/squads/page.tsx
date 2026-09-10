'use client';

import { useState } from 'react';

import SquadsList from '@/components/common/squads/squads-list';
import MainLayout from '@/components/layout/main-layout';
import { Button } from '@/components/ui/button';

export default function SquadsPage() {
   const [creating, setCreating] = useState(false);

   const header = (
      <div className="flex w-full items-start justify-between gap-4 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">Squads</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">
               Agents and people under one leader agent. Give an issue to a squad and its leader splits the work.
            </p>
         </div>
         <Button size="xs" variant="secondary" onClick={() => setCreating(true)}>
            New squad
         </Button>
      </div>
   );

   return (
      <MainLayout header={header}>
         <SquadsList creating={creating} onCreatingChange={setCreating} />
      </MainLayout>
   );
}
