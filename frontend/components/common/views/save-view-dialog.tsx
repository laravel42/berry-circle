'use client';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { createSavedView, toUiView } from '@/lib/views';
import { useFilterStore } from '@/store/filter-store';
import { useSessionStore } from '@/store/session-store';
import { useViewStore } from '@/store/view-store';
import { useViewsStore } from '@/store/views-store';
import { useState } from 'react';
import { toast } from 'sonner';

/** Saves the current filters and layout as a named view. */
export function SaveViewDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const user = useSessionStore((state) => state.user);
   const { filters } = useFilterStore();
   const { viewType } = useViewStore();
   const { views, hydrateViews } = useViewsStore();
   const [name, setName] = useState('');
   const [shared, setShared] = useState(false);

   const save = () => {
      if (!user) return;
      void createSavedView({
         workspaceId,
         name: name.trim(),
         visibility: shared ? 'workspace' : 'private',
         query: { filters: JSON.parse(JSON.stringify(filters)) as unknown },
         display: { layout: viewType },
      })
         .then((saved) => {
            hydrateViews([toUiView(saved, user, user.id), ...views]);
            setName('');
            onOpenChange(false);
            toast.success('View saved');
         })
         .catch(() => toast.error('The view could not be saved.'));
   };

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent>
            <DialogHeader>
               <DialogTitle>Save as view</DialogTitle>
            </DialogHeader>
            <Input placeholder="View name" value={name} onChange={(event) => setName(event.target.value)} />
            <label className="flex items-center justify-between">
               Share with the workspace
               <Switch checked={shared} onCheckedChange={setShared} />
            </label>
            <DialogFooter>
               <Button onClick={save} disabled={!name.trim() || !workspaceId}>
                  Save
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
