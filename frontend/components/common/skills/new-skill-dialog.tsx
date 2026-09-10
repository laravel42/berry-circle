'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import { createSkill, type Skill } from '@/lib/skills';

interface NewSkillDialogProps {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   onCreated: (skill: Skill) => void;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export default function NewSkillDialog({ open, onOpenChange, onCreated }: NewSkillDialogProps) {
   const [name, setName] = useState('');
   const [description, setDescription] = useState('');
   const [content, setContent] = useState('');
   const [busy, setBusy] = useState(false);
   const nameValid = NAME.test(name);

   const submit = async () => {
      setBusy(true);
      try {
         const skill = await createSkill({ name, description, content, labels: [], files: [] });
         toast.success(`Created ${skill.name}`);
         setName('');
         setDescription('');
         setContent('');
         onCreated(skill);
         onOpenChange(false);
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : 'The skill could not be created.');
      } finally {
         setBusy(false);
      }
   };

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="sm:max-w-lg">
            <DialogHeader>
               <DialogTitle>New skill</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
               <label className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground">Name (lowercase letters, digits and dashes)</span>
                  <Input value={name} onChange={(event) => setName(event.target.value.toLowerCase())} />
               </label>
               <label className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground">Description</span>
                  <Input value={description} onChange={(event) => setDescription(event.target.value)} />
               </label>
               <label className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground">Instructions</span>
                  <Textarea rows={6} value={content} onChange={(event) => setContent(event.target.value)} />
               </label>
               <div className="flex justify-end">
                  <Button size="sm" disabled={busy || !nameValid} onClick={() => void submit()}>
                     Create
                  </Button>
               </div>
            </div>
         </DialogContent>
      </Dialog>
   );
}
