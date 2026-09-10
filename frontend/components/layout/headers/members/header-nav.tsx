'use client';

import { Button } from '@/components/ui/button';
import { useMembersStore } from '@/store/members-store';
import { Plus } from 'lucide-react';

export default function HeaderNav() {
   const memberCount = useMembersStore((state) => state.members.length);
   return (
      <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10">
         <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
               <span className="font-medium">Members</span>
               <span className="bg-accent rounded-md px-1.5 py-1">{memberCount}</span>
            </div>
         </div>
         <div className="flex items-center gap-2">
            <Button className="relative" size="xs" variant="secondary">
               <Plus className="size-4" />
               Invite
            </Button>
         </div>
      </div>
   );
}
