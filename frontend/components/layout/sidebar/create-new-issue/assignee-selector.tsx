'use client';

import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useIssuesStore } from '@/store/issues-store';
import { User, users } from '@/data/users';
import { agentToUser } from '@/lib/agents';
import { listSquads, type Squad } from '@/lib/squads';
import { useAgentsStore } from '@/store/agents-store';
import { CheckIcon, UserCircle, UsersRound } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

interface AssigneeSelectorProps {
   assignee: User | null;
   onChange: (assignee: User | null) => void;
   /**
    * Offer squads too. Choosing one assigns its leader through `onChange`, as
    * before, and reports the squad here so the caller can give it the issue
    * once the issue exists. Any other choice reports null.
    */
   onSquadChange?: (squad: Squad | null) => void;
}

export function AssigneeSelector({ assignee, onChange, onSquadChange }: AssigneeSelectorProps) {
   const id = useId();
   const [open, setOpen] = useState<boolean>(false);
   const [value, setValue] = useState<string | null>(assignee?.id || null);

   const { filterByAssignee } = useIssuesStore();
   const agents = useAgentsStore((state) => state.agents);
   const people: User[] = [...users, ...agents.map(agentToUser)].filter(
      (person, index, list) => list.findIndex((entry) => entry.id === person.id) === index
   );

   useEffect(() => {
      setValue(assignee?.id || null);
   }, [assignee]);

   const [squads, setSquads] = useState<Squad[]>([]);
   const [squadId, setSquadId] = useState<string | null>(null);
   // Loaded when the popover opens: squads change rarely, and most people
   // never open the picker at all.
   useEffect(() => {
      if (!open || !onSquadChange) return;
      let cancelled = false;
      listSquads().then(
         (found) => {
            if (!cancelled) setSquads(found);
         },
         () => undefined
      );
      return () => {
         cancelled = true;
      };
   }, [open, onSquadChange]);

   const handleSquadChange = (squad: Squad) => {
      const leader = people.find((person) => person.id === squad.leaderAgentId);
      setSquadId(squad.id);
      setValue(squad.leaderAgentId);
      if (leader) onChange(leader);
      onSquadChange?.(squad);
      setOpen(false);
   };

   const handleAssigneeChange = (userId: string) => {
      setSquadId(null);
      onSquadChange?.(null);
      if (userId === 'unassigned') {
         setValue(null);
         onChange(null);
      } else {
         setValue(userId);
         const newAssignee = people.find((u) => u.id === userId);
         if (newAssignee) {
            onChange(newAssignee);
         }
      }
      setOpen(false);
   };

   return (
      <div className="*:not-first:mt-2">
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
                  {value ? (
                     (() => {
                        const selectedUser = people.find((user) => user.id === value);
                        if (selectedUser) {
                           return (
                              <Avatar className="size-5">
                                 <AvatarImage
                                    src={selectedUser.avatarUrl}
                                    alt={selectedUser.name}
                                 />
                                 <AvatarFallback>{selectedUser.name.charAt(0)}</AvatarFallback>
                              </Avatar>
                           );
                        }
                        return <UserCircle className="size-5" />;
                     })()
                  ) : (
                     <UserCircle className="size-5" />
                  )}
                  <span>
                     {squadId
                        ? (squads.find((squad) => squad.id === squadId)?.name ?? 'Squad')
                        : value
                          ? people.find((user) => user.id === value)?.name
                          : 'Unassigned'}
                  </span>
               </Button>
            </PopoverTrigger>
            <PopoverContent
               className="border-input w-full min-w-[var(--radix-popper-anchor-width)] p-0"
               align="start"
            >
               <Command>
                  <CommandList>
                     <CommandEmpty>No users found.</CommandEmpty>
                     <CommandGroup>
                        <CommandItem
                           value="unassigned"
                           onSelect={() => handleAssigneeChange('unassigned')}
                           className="flex items-center justify-between"
                        >
                           <div className="flex items-center gap-2">
                              <UserCircle className="size-5" />
                              Unassigned
                           </div>
                           {value === null && <CheckIcon size={16} className="ml-auto" />}
                           <span className="text-muted-foreground">
                              {filterByAssignee(null).length}
                           </span>
                        </CommandItem>
                        {people.map((user) => (
                           <CommandItem
                              key={user.id}
                              value={user.id}
                              onSelect={() => handleAssigneeChange(user.id)}
                              className="flex items-center justify-between"
                           >
                              <div className="flex items-center gap-2">
                                 <Avatar className="size-5">
                                    <AvatarImage src={user.avatarUrl} alt={user.name} />
                                    <AvatarFallback>{user.name.charAt(0)}</AvatarFallback>
                                 </Avatar>
                                 {user.name}
                              </div>
                              {value === user.id && <CheckIcon size={16} className="ml-auto" />}
                              <span className="text-muted-foreground">
                                 {filterByAssignee(user.id).length}
                              </span>
                           </CommandItem>
                        ))}
                     </CommandGroup>
                     {onSquadChange && squads.length > 0 ? (
                        <CommandGroup heading="Squads">
                           {squads.map((squad) => (
                              <CommandItem
                                 key={squad.id}
                                 value={`squad:${squad.id}`}
                                 onSelect={() => handleSquadChange(squad)}
                                 className="flex items-center justify-between"
                              >
                                 <div className="flex items-center gap-2">
                                    <UsersRound className="size-5" />
                                    {squad.name}
                                 </div>
                                 {squadId === squad.id && <CheckIcon size={16} className="ml-auto" />}
                              </CommandItem>
                           ))}
                        </CommandGroup>
                     ) : null}
                  </CommandList>
               </Command>
            </PopoverContent>
         </Popover>
      </div>
   );
}
