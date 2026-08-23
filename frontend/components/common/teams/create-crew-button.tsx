'use client';

import { CreateCrewDialog } from '@/components/common/teams/create-crew-dialog';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { useState } from 'react';

export function CreateCrewButton() {
   const [open, setOpen] = useState(false);

   return (
      <>
         <Button className="relative" size="xs" variant="secondary" onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            Add crew
         </Button>
         <CreateCrewDialog open={open} onOpenChange={setOpen} />
      </>
   );
}
