'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { User } from '@/data/users';
import { useMembersStore } from '@/store/members-store';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

interface ProjectLeadSelectorProps {
   lead: User;
   onChange: (lead: User) => void;
}

export function ProjectLeadSelector({ lead, onChange }: ProjectLeadSelectorProps) {
   const id = useId();
   const [open, setOpen] = useState(false);
   const [value, setValue] = useState(lead.id);
   const members = useMembersStore((state) => state.members);

   const candidates = useMemo(() => {
      if (members.some((user) => user.id === lead.id)) {
         return members;
      }
      return [lead, ...members];
   }, [lead, members]);

   useEffect(() => {
      setValue(lead.id);
   }, [lead.id]);

   const selected = candidates.find((user) => user.id === value);

   const handleChange = (userId: string) => {
      setValue(userId);
      setOpen(false);
      const next = candidates.find((user) => user.id === userId);
      if (next) {
         onChange(next);
      }
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               id={id}
               className="flex items-center justify-center"
               size="xs"
               variant="secondary"
               role="combobox"
               aria-expanded={open}
            >
               {selected ? (
                  <>
                     <Avatar className="size-4">
                        <AvatarImage src={selected.avatarUrl} alt={selected.name} />
                        <AvatarFallback>{selected.name.charAt(0)}</AvatarFallback>
                     </Avatar>
                     <span>{selected.name}</span>
                  </>
               ) : (
                  <span>Lead</span>
               )}
            </Button>
         </PopoverTrigger>
         <PopoverContent
            className="border-input w-full min-w-[var(--radix-popper-anchor-width)] p-0"
            align="start"
         >
            <Command>
               <CommandList>
                  <CommandEmpty>No user found.</CommandEmpty>
                  <CommandGroup>
                     {candidates.map((user) => (
                        <CommandItem
                           key={user.id}
                           value={user.id}
                           onSelect={() => handleChange(user.id)}
                           className="flex items-center justify-between"
                        >
                           <div className="flex items-center gap-2">
                              <Avatar className="size-5">
                                 <AvatarImage src={user.avatarUrl} alt={user.name} />
                                 <AvatarFallback>{user.name.charAt(0)}</AvatarFallback>
                              </Avatar>
                              <span>{user.name}</span>
                           </div>
                           {value === user.id && <CheckIcon size={16} className="ml-auto" />}
                        </CommandItem>
                     ))}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}
