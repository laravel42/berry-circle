'use client';

import AutopilotDialog from '@/components/common/autopilots/autopilot-dialog';
import { Button } from '@/components/ui/button';
import { useState } from 'react';

export default function Header() {
   const [open, setOpen] = useState(false);
   return (
      <header className="flex h-auto w-full items-start justify-between gap-4 border-b px-6 py-3">
         <div className="min-w-0">
            <span className="font-medium">Autopilots</span>
            <p className="mt-1 max-w-2xl text-muted-foreground">
               Standing instructions for agents. Each firing — scheduled, from a webhook or by hand
               — becomes one agent task you can follow like any other.
            </p>
         </div>
         <Button className="h-9 shrink-0" onClick={() => setOpen(true)}>
            new autopilot
         </Button>
         <AutopilotDialog open={open} onOpenChange={setOpen} />
      </header>
   );
}
