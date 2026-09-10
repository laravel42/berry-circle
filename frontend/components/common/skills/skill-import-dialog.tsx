'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BerryApiError } from '@/lib/api';
import { importSkillFromUrl, importSkillZip, type Skill } from '@/lib/skills';

interface SkillImportDialogProps {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   onImported: (skill: Skill) => void;
}

/** The server explains an import failure (missing SKILL.md, too large, bad URL) in its message. */
function failureMessage(error: unknown): string {
   return error instanceof BerryApiError ? error.message : 'The skill could not be imported.';
}

export default function SkillImportDialog({ open, onOpenChange, onImported }: SkillImportDialogProps) {
   const [url, setUrl] = useState('');
   const [file, setFile] = useState<File | null>(null);
   const [busy, setBusy] = useState(false);

   const run = async (work: () => Promise<Skill>) => {
      setBusy(true);
      try {
         const skill = await work();
         toast.success(`Imported ${skill.name}`);
         setUrl('');
         setFile(null);
         onImported(skill);
         onOpenChange(false);
      } catch (error) {
         toast.error(failureMessage(error));
      } finally {
         setBusy(false);
      }
   };

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="sm:max-w-lg">
            <DialogHeader>
               <DialogTitle>Import a skill</DialogTitle>
            </DialogHeader>
            <Tabs defaultValue="github">
               <TabsList>
                  <TabsTrigger value="github">From GitHub</TabsTrigger>
                  <TabsTrigger value="zip">Upload zip</TabsTrigger>
               </TabsList>
               <TabsContent value="github" className="flex flex-col gap-3 pt-3">
                  <p className="text-muted-foreground">
                     Paste the URL of a public GitHub folder that holds a SKILL.md.
                  </p>
                  <Input
                     value={url}
                     onChange={(event) => setUrl(event.target.value)}
                     placeholder="https://github.com/owner/repo/tree/main/skills/my-skill"
                     aria-label="GitHub folder URL"
                  />
                  <div className="flex justify-end">
                     <Button
                        size="sm"
                        disabled={busy || url.trim() === ''}
                        onClick={() => void run(() => importSkillFromUrl(url.trim()))}
                     >
                        Import
                     </Button>
                  </div>
               </TabsContent>
               <TabsContent value="zip" className="flex flex-col gap-3 pt-3">
                  <p className="text-muted-foreground">
                     Upload a zip whose top level (or single folder) holds a SKILL.md.
                  </p>
                  <input
                     type="file"
                     accept=".zip,application/zip"
                     aria-label="Skill zip file"
                     onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  />
                  <div className="flex justify-end">
                     <Button
                        size="sm"
                        disabled={busy || file === null}
                        onClick={() => {
                           if (file) void run(() => importSkillZip(file));
                        }}
                     >
                        Upload
                     </Button>
                  </div>
               </TabsContent>
            </Tabs>
         </DialogContent>
      </Dialog>
   );
}
