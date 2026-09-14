'use client';

import { FileText, Folder, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import {
   MAIN_FILE,
   buildTree,
   pathProblem,
   readFrontmatter,
   writeFrontmatter,
   type PathProblem,
   type TreeNode,
} from '@/lib/skill-files';
import { deleteSkill, getSkill, refreshSkill, updateSkill, type Skill } from '@/lib/skills';
import { cn } from '@/lib/utils';

interface Draft {
   name: string;
   description: string;
   labels: string[];
   /** The SKILL.md itself, frontmatter and all. */
   content: string;
   files: Array<{ path: string; content: string }>;
}

interface Props {
   skillId: string;
   canEdit: boolean;
   /** Told when the skill changed, so the list beside this panel keeps up. */
   onChanged?: () => void;
   onClose?: () => void;
}

function toDraft(skill: Skill): Draft {
   return {
      name: skill.name,
      description: skill.description,
      labels: skill.labels,
      content: skill.content,
      files: skill.files.map((file) => ({ path: file.path, content: file.content ?? '' })),
   };
}

/** The named parts of a skill, which are also what the save bar can list. */
type ChangedPart = 'details' | 'labels' | 'instructions' | 'files';

/** What the save bar says: the parts that differ from what was loaded. */
function changeSummary(draft: Draft, loaded: Draft): ChangedPart[] {
   const parts: ChangedPart[] = [];
   if (draft.name !== loaded.name || draft.description !== loaded.description)
      parts.push('details');
   if (draft.labels.join(',') !== loaded.labels.join(',')) parts.push('labels');
   if (draft.content !== loaded.content) parts.push('instructions');
   if (JSON.stringify(draft.files) !== JSON.stringify(loaded.files)) parts.push('files');
   return parts;
}

/**
 * One skill: what it is, and what it carries.
 *
 * Editing is local until it is saved, so the save bar can say what is about to
 * change and offer to throw it away. Before a save the skill is re-read: if
 * someone else saved meanwhile, the banner says so rather than silently
 * writing over their work.
 */
export default function SkillDetail({ skillId, canEdit, onChanged, onClose }: Props) {
   const t = useTranslations('areas.skills');
   const { orgId } = useParams<{ orgId: string }>();
   const [loaded, setLoaded] = useState<Skill | null>(null);
   const [draft, setDraft] = useState<Draft | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);
   const [conflict, setConflict] = useState<Skill | null>(null);
   const [openPath, setOpenPath] = useState<string>(MAIN_FILE);
   const [mode, setMode] = useState<'preview' | 'edit' | 'raw'>('preview');
   const [newPath, setNewPath] = useState('');
   const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
   const [confirmRefresh, setConfirmRefresh] = useState(false);
   const [confirmDelete, setConfirmDelete] = useState(false);

   const take = useCallback((skill: Skill) => {
      setLoaded(skill);
      setDraft(toDraft(skill));
      setConflict(null);
   }, []);

   useEffect(() => {
      let cancelled = false;
      setLoaded(null);
      setDraft(null);
      setError(null);
      getSkill(skillId)
         .then((found) => {
            if (!cancelled) take(found);
         })
         .catch((failure: unknown) => {
            if (!cancelled) {
               setError(
                  failure instanceof BerryApiError ? failure.message : t('detail.loadFailed')
               );
            }
         });
      return () => {
         cancelled = true;
      };
   }, [skillId, take, t]);

   const loadedDraft = useMemo(() => (loaded ? toDraft(loaded) : null), [loaded]);
   const changes = draft && loadedDraft ? changeSummary(draft, loadedDraft) : [];

   if (error) return <p className="px-6 py-8 text-muted-foreground">{error}</p>;
   if (!draft || !loaded)
      return <p className="px-6 py-8 text-muted-foreground">{t('detail.loading')}</p>;

   const fail = (failure: unknown, fallback: string) =>
      toast.error(failure instanceof BerryApiError ? failure.message : fallback);

   const edit = (patch: Partial<Draft>) =>
      setDraft((current) => (current ? { ...current, ...patch } : current));

   /** The overview fields and the SKILL.md frontmatter are one thing. */
   const editIdentity = (patch: { name?: string; description?: string }) => {
      setDraft((current) => {
         if (!current) return current;
         const next = { ...current, ...patch };
         return {
            ...next,
            content: writeFrontmatter(next.content, {
               name: next.name,
               description: next.description,
            }),
         };
      });
   };

   const editContent = (content: string) => {
      const frontmatter = readFrontmatter(content);
      setDraft((current) =>
         current
            ? {
                 ...current,
                 content,
                 name: frontmatter.name ?? current.name,
                 description: frontmatter.description ?? current.description,
              }
            : current
      );
   };

   const write = async (force: boolean) => {
      setBusy(true);
      try {
         if (!force) {
            const fresh = await getSkill(skillId);
            if (fresh.updatedAt !== loaded.updatedAt) {
               setConflict(fresh);
               return;
            }
         }
         const saved = await updateSkill(skillId, {
            name: draft.name,
            description: draft.description,
            labels: draft.labels,
            content: draft.content,
            files: draft.files,
         });
         take(saved);
         toast.success(t('detail.saved'));
         onChanged?.();
      } catch (failure) {
         fail(failure, t('detail.saveFailed'));
      } finally {
         setBusy(false);
      }
   };

   const refresh = async () => {
      setBusy(true);
      try {
         take(await refreshSkill(skillId));
         toast.success(t('refresh.done'));
         onChanged?.();
      } catch (failure) {
         fail(failure, t('refresh.failed'));
      } finally {
         setBusy(false);
      }
   };

   const remove = async () => {
      setBusy(true);
      try {
         await deleteSkill(skillId);
         toast.success(t('row.deleted', { name: loaded.name }));
         onChanged?.();
         onClose?.();
      } catch (failure) {
         fail(failure, t('row.deleteFailed'));
      } finally {
         setBusy(false);
      }
   };

   const paths = draft.files.map((file) => file.path);
   const problemText = (problem: PathProblem): string =>
      problem === 'reserved'
         ? t('detail.pathReserved', { file: MAIN_FILE })
         : t(`detail.path_${problem}`);
   const addProblem = newPath.trim() === '' ? null : pathProblem(newPath, paths);
   const renameProblem =
      renaming === null || renaming.value.trim() === ''
         ? null
         : pathProblem(
              renaming.value,
              paths.filter((path) => path !== renaming.path)
           );

   const openFile =
      openPath === MAIN_FILE ? null : draft.files.find((file) => file.path === openPath);
   const shownText = openPath === MAIN_FILE ? draft.content : (openFile?.content ?? '');
   const setShownText = (value: string) => {
      if (openPath === MAIN_FILE) {
         editContent(value);
         return;
      }
      edit({
         files: draft.files.map((file) =>
            file.path === openPath ? { ...file, content: value } : file
         ),
      });
   };

   const renderTree = (nodes: TreeNode[], depth = 0) =>
      nodes.map((node) => (
         <li key={node.path}>
            <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 12}px` }}>
               {node.isFile ? (
                  <button
                     type="button"
                     onClick={() => setOpenPath(node.path)}
                     className={cn(
                        'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-sidebar/60',
                        openPath === node.path && 'bg-sidebar/70'
                     )}
                  >
                     <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                     <span className="truncate font-mono">{node.name}</span>
                  </button>
               ) : (
                  <span className="flex items-center gap-1.5 px-1.5 py-1 text-muted-foreground">
                     <Folder className="size-3.5 shrink-0" />
                     <span className="truncate font-mono">{node.name}</span>
                  </span>
               )}
               {node.isFile && canEdit ? (
                  <>
                     <Button
                        size="xxs"
                        variant="ghost"
                        onClick={() => setRenaming({ path: node.path, value: node.path })}
                     >
                        {t('detail.rename')}
                     </Button>
                     <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        aria-label={t('detail.deleteFile', { path: node.path })}
                        onClick={() => {
                           edit({ files: draft.files.filter((file) => file.path !== node.path) });
                           if (openPath === node.path) setOpenPath(MAIN_FILE);
                        }}
                     >
                        <Trash2 className="size-3.5" />
                     </Button>
                  </>
               ) : null}
            </div>
            {node.children.length > 0 ? <ul>{renderTree(node.children, depth + 1)}</ul> : null}
         </li>
      ));

   return (
      <div className="flex h-full flex-col">
         <div className="flex flex-wrap items-start justify-between gap-3 border-b px-6 py-4">
            <div className="min-w-0">
               <h2 className="truncate font-medium">{loaded.name}</h2>
               <p className="text-muted-foreground">
                  {loaded.source.kind === 'github' && loaded.source.url ? (
                     <a
                        href={loaded.source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline-offset-2 hover:underline"
                     >
                        {t('source.github')}
                     </a>
                  ) : (
                     t(`source.${loaded.source.kind}`)
                  )}
               </p>
            </div>
            {canEdit ? (
               <div className="flex flex-wrap items-center gap-2">
                  {loaded.source.kind === 'github' ? (
                     <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => setConfirmRefresh(true)}
                     >
                        {t('refresh.action')}
                     </Button>
                  ) : null}
                  <Button
                     size="xs"
                     variant="secondary"
                     disabled={busy}
                     onClick={() => setConfirmDelete(true)}
                  >
                     {t('row.delete')}
                  </Button>
               </div>
            ) : (
               <span className="text-muted-foreground">{t('row.locked')}</span>
            )}
         </div>

         {conflict ? (
            <div className="border-b bg-muted/40 px-6 py-3" role="alert">
               <p className="font-medium">{t('detail.conflict')}</p>
               <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="xs" variant="secondary" onClick={() => take(conflict)}>
                     {t('detail.conflictTakeTheirs')}
                  </Button>
                  <Button size="xs" onClick={() => void write(true)}>
                     {t('detail.conflictKeepMine')}
                  </Button>
               </div>
            </div>
         ) : null}

         <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-6 mt-3 w-fit">
               <TabsTrigger value="overview">{t('detail.overview')}</TabsTrigger>
               <TabsTrigger value="files">{t('detail.files')}</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
               <div className="flex flex-col gap-4">
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('create.name')}</span>
                     <Input
                        value={draft.name}
                        disabled={!canEdit}
                        onChange={(event) => editIdentity({ name: event.target.value })}
                     />
                  </label>
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('create.description')}</span>
                     <Input
                        value={draft.description}
                        disabled={!canEdit}
                        onChange={(event) => editIdentity({ description: event.target.value })}
                     />
                  </label>
                  <p className="text-muted-foreground">
                     {t('detail.frontmatterSynced', { file: MAIN_FILE })}
                  </p>
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('detail.labels')}</span>
                     <Input
                        value={draft.labels.join(', ')}
                        disabled={!canEdit}
                        onChange={(event) =>
                           edit({
                              labels: [
                                 ...new Set(
                                    event.target.value
                                       .split(',')
                                       .map((label) => label.trim())
                                       .filter(Boolean)
                                 ),
                              ],
                           })
                        }
                     />
                  </label>

                  <div className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('detail.usedByAgents')}</span>
                     {loaded.agents.length === 0 ? (
                        <p className="text-muted-foreground">{t('detail.noAgents')}</p>
                     ) : (
                        <ul className="flex flex-wrap gap-2">
                           {loaded.agents.map((agent) => (
                              <li key={agent.id}>
                                 <Link
                                    href={`/${orgId}/agents/${agent.id}`}
                                    className={cn(
                                       'rounded border px-2 py-0.5 hover:bg-sidebar/60',
                                       !agent.enabled && 'text-muted-foreground'
                                    )}
                                 >
                                    {agent.name}
                                    {agent.enabled ? '' : ` · ${t('detail.switchedOff')}`}
                                 </Link>
                              </li>
                           ))}
                        </ul>
                     )}
                  </div>
               </div>
            </TabsContent>

            <TabsContent value="files" className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
               <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
                  <div className="flex flex-col gap-2">
                     <ul className="rounded-md border p-1">
                        <li>
                           <button
                              type="button"
                              onClick={() => setOpenPath(MAIN_FILE)}
                              className={cn(
                                 'flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-sidebar/60',
                                 openPath === MAIN_FILE && 'bg-sidebar/70'
                              )}
                           >
                              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="font-mono">{MAIN_FILE}</span>
                           </button>
                        </li>
                        {renderTree(buildTree(paths))}
                     </ul>
                     {canEdit ? (
                        <div className="flex flex-col gap-1.5">
                           <div className="flex gap-2">
                              <Input
                                 className="h-7"
                                 value={newPath}
                                 placeholder={t('detail.filePath')}
                                 aria-label={t('detail.addFile')}
                                 onChange={(event) => setNewPath(event.target.value)}
                              />
                              <Button
                                 size="xs"
                                 disabled={newPath.trim() === '' || addProblem !== null}
                                 onClick={() => {
                                    edit({
                                       files: [
                                          ...draft.files,
                                          { path: newPath.trim(), content: '' },
                                       ],
                                    });
                                    setOpenPath(newPath.trim());
                                    setNewPath('');
                                 }}
                              >
                                 {t('detail.add')}
                              </Button>
                           </div>
                           {addProblem ? (
                              <p className="text-destructive">{problemText(addProblem)}</p>
                           ) : null}
                        </div>
                     ) : null}
                  </div>

                  <div className="flex min-w-0 flex-col gap-2">
                     <div className="flex flex-wrap items-center gap-2">
                        <span className="mr-auto truncate font-mono">{openPath}</span>
                        {(['preview', 'edit', 'raw'] as const).map((value) => (
                           <Button
                              key={value}
                              size="xs"
                              variant={mode === value ? 'secondary' : 'ghost'}
                              disabled={value === 'edit' && !canEdit}
                              onClick={() => setMode(value)}
                           >
                              {t(`detail.mode_${value}`)}
                           </Button>
                        ))}
                     </div>
                     {mode === 'edit' ? (
                        <Textarea
                           rows={18}
                           className="font-mono"
                           value={shownText}
                           onChange={(event) => setShownText(event.target.value)}
                        />
                     ) : mode === 'raw' ? (
                        <pre className="max-h-[32rem] overflow-auto rounded-md border bg-muted/30 p-3 font-mono">
                           {shownText}
                        </pre>
                     ) : (
                        <div className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/20 p-3">
                           {shownText === '' ? t('detail.emptyFile') : shownText}
                        </div>
                     )}
                  </div>
               </div>
            </TabsContent>
         </Tabs>

         {canEdit && changes.length > 0 ? (
            <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t bg-container px-6 py-2">
               <span className="mr-auto text-muted-foreground">
                  {t('detail.unsaved', {
                     what: changes.map((part) => t(`detail.change_${part}`)).join(', '),
                  })}
               </span>
               <Button size="xs" variant="ghost" disabled={busy} onClick={() => take(loaded)}>
                  {t('detail.discard')}
               </Button>
               <Button size="xs" disabled={busy} onClick={() => void write(false)}>
                  {t('detail.save')}
               </Button>
            </div>
         ) : null}

         <AlertDialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>{t('detail.rename')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('detail.renameBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <Input
                  value={renaming?.value ?? ''}
                  aria-label={t('detail.filePath')}
                  onChange={(event) =>
                     setRenaming((current) =>
                        current ? { ...current, value: event.target.value } : current
                     )
                  }
               />
               {renameProblem ? (
                  <p className="text-destructive">{problemText(renameProblem)}</p>
               ) : null}
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                     disabled={
                        renaming === null || renameProblem !== null || renaming.value.trim() === ''
                     }
                     onClick={() => {
                        if (!renaming) return;
                        const to = renaming.value.trim();
                        edit({
                           files: draft.files.map((file) =>
                              file.path === renaming.path ? { ...file, path: to } : file
                           ),
                        });
                        if (openPath === renaming.path) setOpenPath(to);
                        setRenaming(null);
                     }}
                  >
                     {t('detail.rename')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>

         <AlertDialog open={confirmRefresh} onOpenChange={setConfirmRefresh}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>{t('refresh.title', { name: loaded.name })}</AlertDialogTitle>
                  <AlertDialogDescription>{t('refresh.body')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void refresh()}>
                     {t('refresh.action')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>

         <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     {t('row.confirmDeleteTitle', { name: loaded.name })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>{t('row.confirmDeleteBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void remove()}>
                     {t('row.delete')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}
