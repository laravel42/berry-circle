'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { issues } from '@/data/issues';
import { labels } from '@/data/labels';
import { useMemo, useState } from 'react';
import { SelectMenu } from './shared';

const formatCount = (count: number) =>
   count >= 1000 ? `${(count / 1000).toFixed(1)}K` : String(count);

/** Workspace "Issue labels" settings: filterable table of every label. */
export default function IssueLabelsSettings() {
   const [query, setQuery] = useState('');

   const rows = useMemo(() => {
      const counts = new Map<string, number>();
      for (const issue of issues) {
         for (const label of issue.labels) {
            counts.set(label.id, (counts.get(label.id) ?? 0) + 1);
         }
      }
      return labels
         .map((label) => ({
            ...label,
            issues: counts.get(label.id) ?? 0,
         }))
         .filter((label) => label.name.toLowerCase().includes(query.toLowerCase()))
         .sort((a, b) => a.name.localeCompare(b.name));
   }, [query]);

   return (
      <div className="w-full overflow-y-auto h-full">
         <div className="max-w-5xl mx-auto px-6 py-10 pb-20">
            <h1 className="text-2xl font-medium mb-6">Issue labels</h1>

            <div className="flex items-center justify-between gap-3 mb-6">
               <div className="flex items-center gap-2">
                  <Input
                     placeholder="Filter by name..."
                     value={query}
                     onChange={(event) => setQuery(event.target.value)}
                     className="w-64 h-8"
                  />
                  <SelectMenu options={['Workspace', 'All teams']} />
               </div>
               <div className="flex items-center gap-2">
                  <Button size="xs" variant="secondary">
                     New group
                  </Button>
                  <Button size="xs">New label</Button>
               </div>
            </div>

            {/* Header */}
            <div className="flex items-center px-2 py-1.5 text-xs text-muted-foreground border-b">
               <div className="flex-1 min-w-0">Name ↓</div>
               <div className="w-[70px]">Issues</div>
            </div>

            {rows.map((label) => (
               <div
                  key={label.id}
                  className="flex items-center px-2 py-2.5 text-sm border-b border-muted-foreground/5 hover:bg-sidebar/50"
               >
                  <div className="flex-1 min-w-0 flex items-center gap-2.5">
                     <span
                        className="size-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: label.color }}
                     />
                     <span className="truncate">{label.name}</span>
                  </div>
                  <div className="w-[70px] text-xs text-muted-foreground">
                     {label.issues > 0 && formatCount(label.issues)}
                  </div>
               </div>
            ))}
            {rows.length === 0 && (
               <p className="text-sm text-muted-foreground py-6">No labels match your filter.</p>
            )}
         </div>
      </div>
   );
}
