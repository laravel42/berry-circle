'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { User } from '@/data/users';
import { CheckIcon, UserPlus } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

interface CrewMembersSelectorProps {
   candidates: User[];
   selected: User[];
   onChange: (members: User[]) => void;
}

export function CrewMembersSelector({ candidates, selected, onChange }: CrewMembersSelectorProps) {
   const id = useId();
   const [open, setOpen] = useState(false);
   const selectedIds = useMemo(() => new Set(selected.map((member) => member.id)), [selected]);

   const toggle = (user: User) => {
      if (selectedIds.has(user.id)) {
         onChange(selected.filter((member) => member.id !== user.id));
         return;
      }
      onChange([...selected, user]);
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               id={id}
               type="button"
               className={selected.length === 0 ? 'text-muted-foreground' : undefined}
               size="xs"
               variant="secondary"
               role="combobox"
               aria-expanded={open}
               aria-label={
                  selected.length > 0
                     ? `Additional members: ${selected.map((member) => member.name).join(', ')}`
                     : 'Add members'
               }
            >
               {selected.length > 0 ? (
                  <>
                     <span className="flex -space-x-1.5">
                        {selected.slice(0, 4).map((member) => (
                           <Avatar key={member.id} className="size-4 border border-background">
                              <AvatarImage src={member.avatarUrl} alt={member.name} />
                              <AvatarFallback>{member.name.charAt(0)}</AvatarFallback>
                           </Avatar>
                        ))}
                     </span>
                     <span>
                        {selected.length === 1 ? selected[0].name : `${selected.length} members`}
                     </span>
                  </>
               ) : (
                  <>
                     <UserPlus className="size-3.5" />
                     <span>Add members</span>
                  </>
               )}
            </Button>
         </PopoverTrigger>
         <PopoverContent className="border-input w-72 p-0" align="start">
            <Command>
               <CommandInput placeholder="Search members…" />
               <CommandList>
                  <CommandEmpty>No members available.</CommandEmpty>
                  <CommandGroup>
                     {candidates.map((user) => (
                        <CommandItem
                           key={user.id}
                           value={`${user.name} ${user.id}`}
                           onSelect={() => toggle(user)}
                           className="flex items-center justify-between"
                        >
                           <div className="flex min-w-0 items-center gap-2">
                              <Avatar className="size-5">
                                 <AvatarImage src={user.avatarUrl} alt={user.name} />
                                 <AvatarFallback>{user.name.charAt(0)}</AvatarFallback>
                              </Avatar>
                              <span className="truncate">{user.name}</span>
                              {user.role === 'Application' && (
                                 <span className="text-xs text-muted-foreground">Agent</span>
                              )}
                           </div>
                           {selectedIds.has(user.id) && <CheckIcon size={16} className="ml-auto" />}
                        </CommandItem>
                     ))}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}
