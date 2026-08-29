'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   archiveLabel,
   createLabel,
   loadLabels,
   updateLabel,
   type WorkspaceLabel,
} from '@/lib/settings';
import { useSessionStore } from '@/store/session-store';
import { Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSettingsResource } from './use-settings-resource';

/**
 * Workspace "Task labels": the vocabulary a task can be tagged with.
 *
 * The per-label task count this page used to show is gone. It was counted
 * from the mock issue list, and counting it honestly would mean a query per
 * label — the server does not answer it, and a number that is quietly wrong is
 * worse than no number.
 *
 * Removing a label archives it. A label already on a task has to stay
 * nameable, or every task carrying it renders a blank chip; the name becomes
 * free again either way, because the uniqueness index only covers live rows.
 */

const PALETTE = [
   '#6366f1',
   '#f97316',
   '#347b5a',
   '#9b6715',
   '#397caf',
   '#b4436c',
   '#7c5cbf',
   '#4a5568',
];

export default function IssueLabelsSettings() {
   const workspace = useSessionStore((state) => state.workspace);
   const workspaceId = workspace?.id ?? '';

   const labels = useSettingsResource<WorkspaceLabel[]>(
      () =>
         workspaceId ? loadLabels(workspaceId) : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );

   const [query, setQuery] = useState('');
   const [name, setName] = useState('');
   const [creating, setCreating] = useState(false);

   const rows = useMemo(() => {
      const needle = query.trim().toLowerCase();
      return (labels.value ?? [])
         .filter((label) => label.name.toLowerCase().includes(needle))
         .sort((a, b) => a.name.localeCompare(b.name));
   }, [labels.value, query]);

   const create = async () => {
      const trimmed = name.trim();
      if (trimmed === '') return;
      setCreating(true);
      try {
         // A colour per label, chosen from the palette by name so the same
         // label is the same colour on every workspace that has it.
         const colour = PALETTE[hash(trimmed) % PALETTE.length]!;
         const saved = await createLabel(workspaceId, { name: trimmed, color: colour });
         labels.set([...(labels.value ?? []), saved]);
         setName('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'That label could not be created.');
      } finally {
         setCreating(false);
      }
   };

   const recolour = (label: WorkspaceLabel) => {
      const next = PALETTE[(PALETTE.indexOf(label.color) + 1) % PALETTE.length]!;
      void labels.mutate(
         (labels.value ?? []).map((entry) =>
            entry.id === label.id ? { ...entry, color: next } : entry
         ),
         () => updateLabel(workspaceId, label.id, { color: next }).then(() => undefined)
      );
   };

   const rename = (label: WorkspaceLabel, next: string) => {
      const trimmed = next.trim();
      if (trimmed === '' || trimmed === label.name) return;
      void labels.mutate(
         (labels.value ?? []).map((entry) =>
            entry.id === label.id ? { ...entry, name: trimmed } : entry
         ),
         () => updateLabel(workspaceId, label.id, { name: trimmed }).then(() => undefined)
      );
   };

   const archive = (label: WorkspaceLabel) => {
      void labels.mutate(
         (labels.value ?? []).filter((entry) => entry.id !== label.id),
         () => archiveLabel(workspaceId, label.id)
      );
   };

   return (
      <div className="h-full w-full overflow-y-auto">
         <div className="mx-auto max-w-5xl px-6 py-10 pb-20">
            <h1 className="mb-6 font-medium">Task labels</h1>

            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
               <Input
                  placeholder="Filter by name…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-8 w-64"
               />
               <div className="flex items-center gap-2">
                  <Input
                     placeholder="New label"
                     value={name}
                     disabled={!workspaceId}
                     className="h-8 w-48"
                     onChange={(event) => setName(event.target.value)}
                     onKeyDown={(event) => {
                        if (event.key === 'Enter') void create();
                     }}
                  />
                  <Button size="xs" disabled={creating || name.trim() === ''} onClick={() => void create()}>
                     {creating ? <Loader2 className="size-3.5 animate-spin" /> : 'Create'}
                  </Button>
               </div>
            </div>

            {labels.error ? <p className="py-6 text-status-danger">{labels.error}</p> : null}

            <div className="flex items-center border-b px-2 py-1.5 text-muted-foreground">
               <div className="min-w-0 flex-1">Name</div>
               <div className="w-35 text-right">Colour</div>
               <div className="w-22.5" />
            </div>

            {rows.map((label) => (
               <div
                  key={label.id}
                  className="flex items-center gap-2 border-b border-muted-foreground/5 px-2 py-2 hover:bg-sidebar/50"
               >
                  <button
                     type="button"
                     aria-label={`Change the colour of ${label.name}`}
                     onClick={() => recolour(label)}
                     className="size-2.5 shrink-0 rounded-full"
                     style={{ backgroundColor: label.color }}
                  />
                  <Input
                     defaultValue={label.name}
                     className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-1 hover:border-border"
                     onBlur={(event) => rename(label, event.target.value)}
                     onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                        if (event.key === 'Escape') {
                           event.currentTarget.value = label.name;
                           event.currentTarget.blur();
                        }
                     }}
                  />
                  <span className="w-35 text-right font-mono text-muted-foreground">
                     {label.color}
                  </span>
                  <span className="w-22.5 text-right">
                     <Button
                        size="xs"
                        variant="ghost"
                        className="text-status-danger hover:text-status-danger"
                        disabled={labels.saving}
                        onClick={() => archive(label)}
                     >
                        Remove
                     </Button>
                  </span>
               </div>
            ))}

            {!labels.loading && rows.length === 0 && !labels.error ? (
               <p className="py-6 text-muted-foreground">
                  {query.trim() === '' ? 'No labels yet.' : 'No labels match your filter.'}
               </p>
            ) : null}
         </div>
      </div>
   );
}

/** Stable across reloads, so a label keeps the colour it was created with. */
function hash(value: string): number {
   let total = 0;
   for (const character of value) total = (total * 31 + character.charCodeAt(0)) >>> 0;
   return total;
}
