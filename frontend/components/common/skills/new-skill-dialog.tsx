'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import {
   MAX_FILES,
   MAX_TOTAL_BYTES,
   MAIN_FILE,
   formatBytes,
   inspectCandidate,
   readFrontmatter,
   stripLeadingFolder,
   type CandidateFile,
   type ImportProblem,
} from '@/lib/skill-files';
import { createSkill, importSkillFromUrl, importSkillZip, type Skill } from '@/lib/skills';
import { readZipEntries, skillPaths, ZipUnreadable } from '@/lib/zip-entries';

interface Props {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   onCreated: (skill: Skill) => void;
   /** The catalogue's names, so a clash is caught before the request. */
   existingNames: string[];
}

const NAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface Preview {
   /** What the skill will be called, and what it will hold. */
   name: string;
   description: string;
   content: string;
   files: CandidateFile[];
   problem: ImportProblem | null;
}

/**
 * Making a skill, four ways: writing one here, bringing in a folder or a zip,
 * or pointing at a GitHub folder.
 *
 * The folder and zip paths are checked in the browser before anything is sent —
 * is the main file there, does it fit — and show what would be imported, so the
 * answer to "why was this refused" arrives before the upload rather than after.
 */
export default function NewSkillDialog({ open, onOpenChange, onCreated, existingNames }: Props) {
   const t = useTranslations('areas.skills');
   const [name, setName] = useState('');
   const [description, setDescription] = useState('');
   const [content, setContent] = useState('');
   const [url, setUrl] = useState('');
   const [zip, setZip] = useState<File | null>(null);
   const [preview, setPreview] = useState<Preview | null>(null);
   const [busy, setBusy] = useState(false);
   const folderInput = useRef<HTMLInputElement>(null);

   // `webkitdirectory` is how a browser offers a folder, and React has no prop
   // for it; setting the attribute keeps the element honestly typed.
   useEffect(() => {
      const element = folderInput.current;
      if (!element) return;
      element.setAttribute('webkitdirectory', '');
      element.setAttribute('directory', '');
   }, [open]);

   const reset = () => {
      setName('');
      setDescription('');
      setContent('');
      setUrl('');
      setZip(null);
      setPreview(null);
   };

   const finish = (skill: Skill) => {
      toast.success(t('create.created', { name: skill.name }));
      reset();
      onCreated(skill);
      onOpenChange(false);
   };

   const run = async (work: () => Promise<Skill>) => {
      setBusy(true);
      try {
         finish(await work());
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : t('create.failed'));
      } finally {
         setBusy(false);
      }
   };

   const taken = existingNames.includes(name.trim());
   const shapeOk = NAME_SHAPE.test(name.trim());
   const nameProblem =
      name.trim() === ''
         ? null
         : taken
           ? t('create.nameTaken')
           : shapeOk
             ? null
             : t('create.nameInvalid');

   /** Reads a chosen folder into a preview: the main file decides the name. */
   const readFolder = async (chosen: FileList | null) => {
      if (!chosen || chosen.length === 0) return;
      const picked = [...chosen];
      const relative = picked.map(
         (file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
      );
      const stripped = stripLeadingFolder(relative);
      const files: CandidateFile[] = [];
      for (const [index, file] of picked.entries()) {
         const path = stripped.get(relative[index] ?? '') ?? file.name;
         files.push({ path, content: await file.text(), bytes: file.size });
      }
      const main = files.find((file) => file.path === MAIN_FILE);
      const frontmatter = readFrontmatter(main?.content ?? '');
      const folderName = (relative[0] ?? '').split('/')[0] ?? '';
      setPreview({
         name: (frontmatter.name ?? folderName)
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .slice(0, 64),
         description: frontmatter.description ?? '',
         content: main?.content ?? '',
         files: files.filter((file) => file.path !== MAIN_FILE),
         problem: inspectCandidate(files),
      });
   };

   /** Reads a zip's directory — names and sizes only; the server unpacks it. */
   const readZip = async (file: File | null) => {
      setZip(file);
      if (!file) {
         setPreview(null);
         return;
      }
      try {
         const entries = skillPaths(readZipEntries(await file.arrayBuffer()));
         setPreview({
            name: file.name.replace(/\.zip$/i, ''),
            description: '',
            content: '',
            files: entries
               .filter((entry) => entry.path !== MAIN_FILE)
               .map((entry) => ({ path: entry.path, content: '', bytes: entry.bytes })),
            problem: inspectCandidate(
               entries.map((entry) => ({ path: entry.path, content: '', bytes: entry.bytes }))
            ),
         });
      } catch (error) {
         setPreview(null);
         toast.error(
            error instanceof ZipUnreadable ? t('create.zipUnreadable') : t('create.failed')
         );
      }
   };

   const problemText = (problem: ImportProblem): string => {
      switch (problem.kind) {
         case 'noMainFile':
            return t('create.noMainFile', { file: MAIN_FILE });
         case 'tooManyFiles':
            return t('create.tooManyFiles', { count: problem.count, max: MAX_FILES });
         case 'tooLarge':
            return t('create.tooLarge', { max: formatBytes(MAX_TOTAL_BYTES) });
         default:
            return t('create.fileTooLarge', { path: problem.path });
      }
   };

   const previewBlock = preview ? (
      <div className="rounded-md border p-3">
         {preview.problem ? (
            <p className="text-destructive" role="alert">
               {problemText(preview.problem)}
            </p>
         ) : (
            <>
               <p className="font-medium">{t('create.preview', { name: preview.name })}</p>
               <p className="text-muted-foreground">
                  {t('create.previewFiles', { count: preview.files.length })}
               </p>
               <ul className="mt-2 max-h-40 overflow-y-auto">
                  {preview.files.slice(0, 50).map((file) => (
                     <li
                        key={file.path}
                        className="flex justify-between gap-3 text-muted-foreground"
                     >
                        <span className="truncate font-mono">{file.path}</span>
                        <span className="shrink-0">{formatBytes(file.bytes)}</span>
                     </li>
                  ))}
               </ul>
            </>
         )}
      </div>
   ) : null;

   return (
      <Dialog
         open={open}
         onOpenChange={(next) => {
            if (!next) reset();
            onOpenChange(next);
         }}
      >
         <DialogContent className="sm:max-w-xl">
            <DialogHeader>
               <DialogTitle>{t('create.title')}</DialogTitle>
            </DialogHeader>
            <Tabs defaultValue="manual">
               <TabsList>
                  <TabsTrigger value="manual">{t('create.manual')}</TabsTrigger>
                  <TabsTrigger value="folder">{t('create.folder')}</TabsTrigger>
                  <TabsTrigger value="zip">{t('create.zip')}</TabsTrigger>
                  <TabsTrigger value="github">{t('create.github')}</TabsTrigger>
               </TabsList>

               <TabsContent value="manual" className="flex flex-col gap-3 pt-3">
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('create.name')}</span>
                     <Input
                        value={name}
                        aria-invalid={nameProblem !== null}
                        onChange={(event) => setName(event.target.value.toLowerCase())}
                     />
                     <span className={nameProblem ? 'text-destructive' : 'text-muted-foreground'}>
                        {nameProblem ?? t('create.nameHint')}
                     </span>
                  </label>
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('create.description')}</span>
                     <Input
                        value={description}
                        onChange={(event) => setDescription(event.target.value)}
                     />
                  </label>
                  <label className="flex flex-col gap-1.5">
                     <span className="text-muted-foreground">{t('create.instructions')}</span>
                     <Textarea
                        rows={6}
                        value={content}
                        onChange={(event) => setContent(event.target.value)}
                     />
                  </label>
                  <div className="flex justify-end">
                     <Button
                        size="sm"
                        disabled={busy || !shapeOk || taken || description.trim() === ''}
                        onClick={() =>
                           void run(() =>
                              createSkill({
                                 name: name.trim(),
                                 description: description.trim(),
                                 content,
                                 labels: [],
                                 files: [],
                              })
                           )
                        }
                     >
                        {t('create.create')}
                     </Button>
                  </div>
               </TabsContent>

               <TabsContent value="folder" className="flex flex-col gap-3 pt-3">
                  <p className="text-muted-foreground">
                     {t('create.folderHint', {
                        file: MAIN_FILE,
                        files: MAX_FILES,
                        size: formatBytes(MAX_TOTAL_BYTES),
                     })}
                  </p>
                  <input
                     ref={folderInput}
                     type="file"
                     multiple
                     aria-label={t('create.folder')}
                     onChange={(event) => void readFolder(event.target.files)}
                  />
                  {previewBlock}
                  <div className="flex justify-end">
                     <Button
                        size="sm"
                        disabled={busy || preview === null || preview.problem !== null}
                        onClick={() => {
                           if (!preview) return;
                           void run(() =>
                              createSkill({
                                 name: preview.name,
                                 description: preview.description,
                                 content: preview.content,
                                 labels: [],
                                 files: preview.files.map((file) => ({
                                    path: file.path,
                                    content: file.content,
                                 })),
                              })
                           );
                        }}
                     >
                        {t('create.import')}
                     </Button>
                  </div>
               </TabsContent>

               <TabsContent value="zip" className="flex flex-col gap-3 pt-3">
                  <p className="text-muted-foreground">
                     {t('create.zipHint', { file: MAIN_FILE })}
                  </p>
                  <input
                     type="file"
                     accept=".zip,application/zip"
                     aria-label={t('create.zip')}
                     onChange={(event) => void readZip(event.target.files?.[0] ?? null)}
                  />
                  {previewBlock}
                  <div className="flex justify-end">
                     <Button
                        size="sm"
                        disabled={busy || zip === null || preview?.problem != null}
                        onClick={() => {
                           if (zip) void run(() => importSkillZip(zip));
                        }}
                     >
                        {t('create.import')}
                     </Button>
                  </div>
               </TabsContent>

               <TabsContent value="github" className="flex flex-col gap-3 pt-3">
                  <p className="text-muted-foreground">
                     {t('create.urlHint', { file: MAIN_FILE })}
                  </p>
                  <Input
                     value={url}
                     aria-label={t('create.urlLabel')}
                     placeholder="https://github.com/owner/repo/tree/main/skills/my-skill"
                     onChange={(event) => setUrl(event.target.value)}
                  />
                  <div className="flex justify-end">
                     <Button
                        size="sm"
                        disabled={busy || url.trim() === ''}
                        onClick={() => void run(() => importSkillFromUrl(url.trim()))}
                     >
                        {t('create.import')}
                     </Button>
                  </div>
               </TabsContent>
            </Tabs>
         </DialogContent>
      </Dialog>
   );
}
