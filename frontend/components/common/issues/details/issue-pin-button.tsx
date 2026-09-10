'use client';

import { Button } from '@/components/ui/button';
import { pinTarget, unpinTarget, type Pin } from '@/lib/pins';
import { usePinsStore } from '@/store/pins-store';
import { useSessionStore } from '@/store/session-store';
import { Pin as PinIcon, PinOff } from 'lucide-react';
import { toast } from 'sonner';

/** Pins or unpins a task, view or project in the rail. */
export function PinToggle({ targetType, targetId }: { targetType: Pin['targetType']; targetId: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const { pins, add, remove } = usePinsStore();
   const existing = pins.find((pin) => pin.targetType === targetType && pin.targetId === targetId);

   const toggle = () => {
      const write = existing
         ? unpinTarget(workspaceId, existing.id).then(() => remove(existing.id))
         : pinTarget(workspaceId, targetType, targetId).then(add);
      void write.catch(() => toast.error('The pin could not be changed.'));
   };

   return (
      <Button variant="ghost" size="icon" className="size-8" onClick={toggle} aria-label={existing ? 'Unpin' : 'Pin'} title={existing ? 'Unpin' : 'Pin'}>
         {existing ? <PinOff className="size-4" /> : <PinIcon className="size-4" />}
      </Button>
   );
}

export function IssuePinButton({ issueId }: { issueId: string }) {
   return <PinToggle targetType="issue" targetId={issueId} />;
}
