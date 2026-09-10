'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { DescriptionTextarea } from '@/components/common/editor/description-textarea';
import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
   AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BerryApiError } from '@/lib/api';
import { deleteSkill, getSkill, refreshSkill, updateSkill, type Skill } from '@/lib/skills';

const message = (error: unknown, fallback: string) =>
   error instanceof BerryApiError ? error.message : fallback;

const splitLabels = (raw: string) =>
   [...new Set(raw.split(',').map((label) => label.trim()).filter(Boolean))];

export default function SkillDetail() {
   const { orgId, skillId } = useParams<{ orgId: string; skillId: string }>();
   const router = useRouter();
   const [skill, setSkill] = useState<Skill | null>(null);
   const [error, setError] = useState<string | null>(null);
   const [name, setName] = useState('');
   const [description, setDescription] = useState('');
   const [labels, setLabels] = useState('');
   const [content, setContent] = useState('');
   const [openFile, setOpenFile] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);

   const load = (next: Skill) => {
      setSkill(next);
      setName(next.name);
      setDescription(next.description);
      setLabels(next.labels.join(', '));
      setContent(next.content);
   };

   useEffect(() => {
      let cancelled = false;
      getSkill(skillId)
         .then((found) => {
            if (!cancelled) load(found);
         })
         .catch((failure: unknown) => {
            if (!cancelled) setError(message(failure, 'This skill could not be loaded.'));
         });
      return () => {
         cancelled = true;
      };
   }, [skillId]);

   if (error) return <p className="px-6 py-8 text-muted-foreground">{error}</p>;
   if (!skill) return <p className="px-6 py-8 text-muted-foreground">Loading skill…</p>;

   const act = async (work: () => Promise<void>) => {
      setBusy(true);
      try {
         await work();
      } finally {
         setBusy(false);
      }
   };

   const save = () =>
      act(async () => {
         try {
            load(await updateSkill(skill.id, { name, description, content, labels: splitLabels(labels) }));
            toast.success('Skill saved');
         } catch (failure) {
            toast.error(message(failure, 'The skill could not be saved.'));
         }
      });

   const refresh = () =>
      act(async () => {
         try {
            load(await refreshSkill(skill.id));
            toast.success('Refreshed from GitHub');
         } catch (failure) {
            toast.error(message(failure, 'The skill could not be refreshed.'));
         }
      });

   const remove = () =>
      act(async () => {
         try {
            await deleteSkill(skill.id);
            toast.success('Skill deleted');
            router.push(`/${orgId}/skills`);
         } catch (failure) {
            toast.error(message(failure, 'The skill could not be deleted.'));
         }
      });

   const shown = skill.files.find((file) => file.path === openFile);

   return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6">
         <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
               <h1 className="truncate font-medium">{skill.name}</h1>
               <p className="text-muted-foreground">
                  {skill.source.kind === 'github' && skill.source.url ? (
                     <>
                        Imported from{' '}
                        <a
                           href={skill.source.url}
                           target="_blank"
                           rel="noreferrer"
                           className="underline-offset-2 hover:underline"
                        >
                           GitHub
                        </a>
                     </>
                  ) : skill.source.kind === 'zip' ? (
                     'Imported from a zip'
                  ) : (
                     'Written here'
                  )}
               </p>
            </div>
            <div className="flex items-center gap-2">
               {skill.source.kind === 'github' ? (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>
                     Refresh from GitHub
                  </Button>
               ) : null}
               <AlertDialog>
                  <AlertDialogTrigger asChild>
                     <Button size="sm" variant="secondary" disabled={busy}>
                        Delete
                     </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                     <AlertDialogHeader>
                        <AlertDialogTitle>Delete {skill.name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                           Agents that use this skill stop carrying it into their tasks.
                        </AlertDialogDescription>
                     </AlertDialogHeader>
                     <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void remove()}>Delete</AlertDialogAction>
                     </AlertDialogFooter>
                  </AlertDialogContent>
               </AlertDialog>
               <Button size="sm" disabled={busy} onClick={() => void save()}>
                  Save
               </Button>
            </div>
         </div>

         <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">Name</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
         </label>
         <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">Description</span>
            <Input value={description} onChange={(event) => setDescription(event.target.value)} />
         </label>
         <label className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">Labels, separated by commas</span>
            <Input value={labels} onChange={(event) => setLabels(event.target.value)} />
         </label>
         <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground">Instructions</span>
            <DescriptionTextarea
               value={content}
               onChange={setContent}
               placeholder="What an agent should know and do when it uses this skill."
            />
         </div>

         <div className="flex flex-col gap-2">
            <span className="text-muted-foreground">Files</span>
            {skill.files.length === 0 ? (
               <p className="text-muted-foreground">This skill has no extra files.</p>
            ) : (
               <ul className="flex flex-col rounded-md border border-border">
                  {skill.files.map((file) => (
                     <li key={file.path} className="border-b border-border last:border-b-0">
                        <button
                           type="button"
                           className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-sidebar/50"
                           onClick={() => setOpenFile(openFile === file.path ? null : file.path)}
                        >
                           <span className="truncate font-mono">{file.path}</span>
                           <span className="shrink-0 text-muted-foreground">{file.size} bytes</span>
                        </button>
                     </li>
                  ))}
               </ul>
            )}
            {shown ? (
               <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono">
                  {shown.content ?? 'This file’s content is not shown in the list. Open the skill again to load it.'}
               </pre>
            ) : null}
         </div>
      </div>
   );
}
