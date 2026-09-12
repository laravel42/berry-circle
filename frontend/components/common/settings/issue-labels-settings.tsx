'use client';

import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { listSkills } from '@/lib/skills';
import {
   archiveLabel,
   createLabel,
   loadLabels,
   updateLabel,
   type WorkspaceLabel,
} from '@/lib/settings';
import { useSessionStore } from '@/store/session-store';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSettingsResource } from './use-settings-resource';

/**
 * Workspace labels: the vocabulary a task can be tagged with, and the one
 * skills are catalogued by.
 *
 * The two are genuinely different things and are shown as such. Task labels
 * are rows in a table the workspace owns — created, renamed, recoloured,
 * removed. Skill labels are not a catalogue at all: they are free text on each
 * skill, so all this page can honestly do is show which ones are in use and
 * how often, and say where they come from. Offering a "create skill label"
 * button would create nothing.
 *
 * Removing a task label archives it, and the confirmation says how many tasks
 * carry it, because that is the number that decides whether removing it is a
 * tidy-up or a loss. A label already on a task has to stay nameable, or every
 * task carrying it renders a blank chip; the name becomes free again either
 * way, because the uniqueness index only covers live rows.
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

type Tab = 'issue' | 'skill';

export default function IssueLabelsSettings() {
   const t = useTranslations('workspaceAdmin.labels');
   const workspace = useSessionStore((state) => state.workspace);
   const workspaceId = workspace?.id ?? '';

   const labels = useSettingsResource<WorkspaceLabel[]>(
      () =>
         workspaceId
            ? loadLabels(workspaceId)
            : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );

   const [tab, setTab] = useState<Tab>('issue');
   const [query, setQuery] = useState('');
   const [name, setName] = useState('');
   const [creating, setCreating] = useState(false);
   const [removing, setRemoving] = useState<WorkspaceLabel | null>(null);
   const [skillLabels, setSkillLabels] = useState<{ name: string; count: number }[] | null>(null);

   // Counted from the skills themselves, because nothing else holds them.
   useEffect(() => {
      let cancelled = false;
      void listSkills()
         .then((skills) => {
            if (cancelled) return;
            const counts = new Map<string, number>();
            for (const skill of skills) {
               for (const label of skill.labels) {
                  counts.set(label, (counts.get(label) ?? 0) + 1);
               }
            }
            setSkillLabels(
               [...counts.entries()]
                  .map(([label, count]) => ({ name: label, count }))
                  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
            );
         })
         .catch(() => {
            if (!cancelled) setSkillLabels([]);
         });
      return () => {
         cancelled = true;
      };
   }, []);

   const rows = useMemo(() => {
      const needle = query.trim().toLowerCase();
      return (labels.value ?? [])
         .filter((label) => label.name.toLowerCase().includes(needle))
         .sort((a, b) => a.name.localeCompare(b.name));
   }, [labels.value, query]);

   const skillRows = useMemo(() => {
      const needle = query.trim().toLowerCase();
      return (skillLabels ?? []).filter((label) => label.name.toLowerCase().includes(needle));
   }, [skillLabels, query]);

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
         toast.error(cause instanceof Error ? cause.message : t('createFailed'));
      } finally {
         setCreating(false);
      }
   };

   const recolour = (label: WorkspaceLabel, next: string) => {
      if (!/^#[0-9a-f]{6}$/.test(next) || next === label.color) return;
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
      setRemoving(null);
      void labels.mutate(
         (labels.value ?? []).filter((entry) => entry.id !== label.id),
         () => archiveLabel(workspaceId, label.id)
      );
   };

   return (
      <div className="h-full w-full overflow-y-auto">
         <div className="mx-auto max-w-5xl px-6 py-10 pb-20">
            <h1 className="mb-1 font-medium">{t('title')}</h1>
            <p className="mb-6 text-muted-foreground">
               {tab === 'issue' ? t('issueLead') : t('skillLead')}
            </p>

            <div className="mb-6 flex flex-wrap items-center gap-2">
               {(['issue', 'skill'] as const).map((option) => (
                  <Button
                     key={option}
                     size="xs"
                     variant={tab === option ? 'secondary' : 'ghost'}
                     aria-pressed={tab === option}
                     onClick={() => setTab(option)}
                  >
                     {option === 'issue' ? t('issueTab') : t('skillTab')}
                  </Button>
               ))}
            </div>

            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
               <Input
                  placeholder={t('filter')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-8 w-64"
               />
               {tab === 'issue' ? (
                  <div className="flex items-center gap-2">
                     <Input
                        placeholder={t('newLabel')}
                        value={name}
                        disabled={!workspaceId}
                        className="h-8 w-48"
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                           if (event.key === 'Enter') void create();
                        }}
                     />
                     <Button
                        size="xs"
                        disabled={creating || name.trim() === ''}
                        onClick={() => void create()}
                     >
                        {creating ? <Loader2 className="size-3.5 animate-spin" /> : t('create')}
                     </Button>
                  </div>
               ) : null}
            </div>

            {labels.error && tab === 'issue' ? (
               <p className="py-6 text-status-danger">{labels.error}</p>
            ) : null}

            {tab === 'issue' ? (
               <>
                  <div className="flex items-center border-b px-2 py-1.5 text-muted-foreground">
                     <div className="min-w-0 flex-1">{t('name')}</div>
                     <div className="w-24 text-right">{t('usage')}</div>
                     <div className="w-35 text-right">{t('colour')}</div>
                     <div className="w-22.5" />
                  </div>

                  {rows.map((label) => (
                     <div
                        key={label.id}
                        className="flex items-center gap-2 border-b border-muted-foreground/5 px-2 py-2 hover:bg-sidebar/50"
                     >
                        <Popover>
                           <PopoverTrigger
                              aria-label={t('changeColour', { name: label.name })}
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: label.color }}
                           />
                           <PopoverContent align="start" className="w-auto p-3">
                              <div className="grid grid-cols-4 gap-2">
                                 {PALETTE.map((colour) => (
                                    <button
                                       key={colour}
                                       type="button"
                                       aria-label={colour}
                                       className="size-6 rounded-full ring-offset-2 ring-offset-popover hover:ring-2 hover:ring-ring"
                                       style={{ backgroundColor: colour }}
                                       onClick={() => recolour(label, colour)}
                                    />
                                 ))}
                              </div>
                              {/* Any colour, not only the eight: a team with a
                                  palette of its own should not have to pick
                                  the nearest one Berry happens to ship. */}
                              <label className="mt-3 flex items-center gap-2">
                                 <input
                                    type="color"
                                    value={label.color}
                                    aria-label={t('customColour')}
                                    className="size-7 cursor-pointer rounded border bg-transparent"
                                    onChange={(event) =>
                                       recolour(label, event.target.value.toLowerCase())
                                    }
                                 />
                                 <span className="text-muted-foreground">{t('customColour')}</span>
                              </label>
                           </PopoverContent>
                        </Popover>
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
                        <span className="w-24 text-right text-muted-foreground">
                           {label.usageCount === undefined
                              ? '—'
                              : t('usageCount', { count: label.usageCount })}
                        </span>
                        <span className="w-35 text-right font-mono text-muted-foreground">
                           {label.color}
                        </span>
                        <span className="w-22.5 text-right">
                           <Button
                              size="xs"
                              variant="ghost"
                              className="text-status-danger hover:text-status-danger"
                              disabled={labels.saving}
                              onClick={() => setRemoving(label)}
                           >
                              {t('remove')}
                           </Button>
                        </span>
                     </div>
                  ))}

                  {!labels.loading && rows.length === 0 && !labels.error ? (
                     <p className="py-6 text-muted-foreground">
                        {query.trim() === '' ? t('empty') : t('noMatch')}
                     </p>
                  ) : null}
               </>
            ) : (
               <>
                  <div className="flex items-center border-b px-2 py-1.5 text-muted-foreground">
                     <div className="min-w-0 flex-1">{t('name')}</div>
                     <div className="w-24 text-right">{t('usage')}</div>
                  </div>
                  {skillRows.map((label) => (
                     <div
                        key={label.name}
                        className="flex items-center gap-2 border-b border-muted-foreground/5 px-2 py-2"
                     >
                        <span className="min-w-0 flex-1 truncate">{label.name}</span>
                        <span className="w-24 text-right text-muted-foreground">
                           {t('skillUsageCount', { count: label.count })}
                        </span>
                     </div>
                  ))}
                  {skillLabels !== null && skillRows.length === 0 ? (
                     <p className="py-6 text-muted-foreground">
                        {query.trim() === '' ? t('skillEmpty') : t('noMatch')}
                     </p>
                  ) : null}
               </>
            )}
         </div>

         <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     {t('removeTitle', { name: removing?.name ?? '' })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                     {removing?.usageCount === undefined
                        ? t('removeBodyUnknown')
                        : t('removeBody', { count: removing.usageCount })}
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => removing && archive(removing)}>
                     {t('remove')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}

/** Stable across reloads, so a label keeps the colour it was created with. */
function hash(value: string): number {
   let total = 0;
   for (const character of value) total = (total * 31 + character.charCodeAt(0)) >>> 0;
   return total;
}
