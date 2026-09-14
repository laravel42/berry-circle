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
import { CheckIcon, User as UserIcon, Workflow } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { AI_WORKFLOW_LEAD, isAiWorkflow } from './ai-workflow';

interface ProjectLeadSelectorProps {
   /** Undefined until the person chooses; nothing is preselected. */
   lead: User | undefined;
   onChange: (lead: User) => void;
}

/** The lead's mark: an automation glyph for Berry, an avatar for a person. */
function LeadMark({ user, size }: { user: User; size: 4 | 5 }) {
   const box = size === 4 ? 'size-4' : 'size-5';
   if (isAiWorkflow(user)) {
      return (
         <span
            className={`${box} flex shrink-0 items-center justify-center rounded-full bg-[var(--shell-accent)]/15 text-[var(--shell-accent)]`}
         >
            <Workflow className={size === 4 ? 'size-2.5' : 'size-3'} />
         </span>
      );
   }
   return (
      <Avatar className={box}>
         <AvatarImage src={user.avatarUrl} alt={user.name} />
         <AvatarFallback>{user.name.charAt(0)}</AvatarFallback>
      </Avatar>
   );
}

export function ProjectLeadSelector({ lead, onChange }: ProjectLeadSelectorProps) {
   const id = useId();
   const [open, setOpen] = useState(false);
   const members = useMembersStore((state) => state.members);

   // Berry first: it is the choice that changes what creating the project
   // does, so it should not be buried under a list of names.
   const candidates = useMemo(() => [AI_WORKFLOW_LEAD, ...members], [members]);

   const handleChange = (userId: string) => {
      setOpen(false);
      const next = candidates.find((user) => user.id === userId);
      if (next) onChange(next);
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
               {lead ? (
                  <>
                     <LeadMark user={lead} size={4} />
                     <span>{lead.name}</span>
                  </>
               ) : (
                  <>
                     <UserIcon className="size-3.5" />
                     <span>Project lead</span>
                  </>
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
                              <LeadMark user={user} size={5} />
                              <span>{user.name}</span>
                              {isAiWorkflow(user) && (
                                 <span className="text-muted-foreground">Berry plans it</span>
                              )}
                           </div>
                           {lead?.id === user.id && <CheckIcon size={16} className="ml-auto" />}
                        </CommandItem>
                     ))}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}
