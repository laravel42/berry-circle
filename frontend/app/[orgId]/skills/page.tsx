'use client';

import { useState } from 'react';

import SkillImportDialog from '@/components/common/skills/skill-import-dialog';
import SkillsList from '@/components/common/skills/skills-list';
import NewSkillDialog from '@/components/common/skills/new-skill-dialog';
import MainLayout from '@/components/layout/main-layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function SkillsPage() {
   const [query, setQuery] = useState('');
   const [version, setVersion] = useState(0);
   const [importing, setImporting] = useState(false);
   const [creating, setCreating] = useState(false);
   const reload = () => setVersion((current) => current + 1);

   const header = (
      <div className="flex w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">Skills</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">
                  Reusable instructions and files your agents carry into their tasks.
               </p>
            </div>
            <div className="flex items-center gap-2">
               <Button size="xs" variant="secondary" onClick={() => setImporting(true)}>
                  Import
               </Button>
               <Button size="xs" variant="secondary" onClick={() => setCreating(true)}>
                  New skill
               </Button>
            </div>
         </div>
         <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills"
            aria-label="Search skills"
            className="max-w-sm"
         />
      </div>
   );

   return (
      <MainLayout header={header}>
         <SkillsList query={query} version={version} />
         <SkillImportDialog open={importing} onOpenChange={setImporting} onImported={reload} />
         <NewSkillDialog open={creating} onOpenChange={setCreating} onCreated={reload} />
      </MainLayout>
   );
}
