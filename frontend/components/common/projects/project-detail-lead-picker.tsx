'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { statusUserColors, type User } from '@/data/users';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

interface ProjectDetailLeadPickerProps {
   lead: User;
   members: User[];
   onLeadChange: (user: User) => void;
}

/** Avatar-only lead control for the project detail sidebar (matches issue AssigneeUser). */
export function ProjectDetailLeadPicker({
   lead,
   members,
   onLeadChange,
}: ProjectDetailLeadPickerProps) {
   const id = useId();
   const [open, setOpen] = useState(false);
   const [value, setValue] = useState(lead.id);
   const roster = members.length > 0 ? members : [lead];

   useEffect(() => {
      setValue(lead.id);
   }, [lead.id]);

   const selected = roster.find((member) => member.id === value) ?? lead;

   const handleChange = (userId: string) => {
      setValue(userId);
      setOpen(false);
      const next = roster.find((member) => member.id === userId);
      if (next) onLeadChange(next);
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <button
               id={id}
               type="button"
               className="relative flex size-7 items-center justify-center rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
               aria-label={`Lead: ${selected.name}`}
            >
               <Avatar className="size-6 shrink-0">
                  <AvatarImage src={selected.avatarUrl} alt={selected.name} />
                  <AvatarFallback>{selected.name[0]}</AvatarFallback>
               </Avatar>
               <span
                  className="border-background absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full border-2"
                  style={{ backgroundColor: statusUserColors[selected.status] }}
               >
                  <span className="sr-only">{selected.status}</span>
               </span>
            </button>
         </PopoverTrigger>
         <PopoverContent className="border-input w-48 p-0" align="start">
            <Command>
               <CommandList>
                  <CommandEmpty>No user found.</CommandEmpty>
                  <CommandGroup>
                     {roster.map((member) => (
                        <CommandItem
                           key={member.id}
                           value={member.id}
                           onSelect={handleChange}
                           className="flex items-center justify-between"
                        >
                           <div className="flex items-center gap-2">
                              <Avatar className="size-5">
                                 <AvatarImage src={member.avatarUrl} alt={member.name} />
                                 <AvatarFallback>{member.name[0]}</AvatarFallback>
                              </Avatar>
                              <span>{member.name}</span>
                           </div>
                           {value === member.id ? <CheckIcon size={14} className="ml-auto" /> : null}
                        </CommandItem>
                     ))}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}
