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
import type { Agent } from '@/lib/agents';
import { useAgentsStore } from '@/store/agents-store';
import { CheckIcon, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';

interface CrewLeaderSelectorProps {
   leader?: Agent;
   onChange: (agent: Agent) => void;
}

export function CrewLeaderSelector({ leader, onChange }: CrewLeaderSelectorProps) {
   const id = useId();
   const [open, setOpen] = useState(false);
   const agents = useAgentsStore((state) => state.agents);

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               id={id}
               type="button"
               className={leader ? undefined : 'text-muted-foreground'}
               size="xs"
               variant="secondary"
               role="combobox"
               aria-expanded={open}
               aria-label={leader ? `Leader agent: ${leader.name}` : 'Choose leader agent'}
            >
               {leader ? (
                  <>
                     <Avatar className="size-4">
                        <AvatarImage src={leader.avatarUrl ?? undefined} alt={leader.name} />
                        <AvatarFallback>{leader.name.charAt(0)}</AvatarFallback>
                     </Avatar>
                     <span>{leader.name}</span>
                  </>
               ) : (
                  <>
                     <Sparkles className="size-3.5" />
                     <span>Choose agent</span>
                  </>
               )}
            </Button>
         </PopoverTrigger>
         <PopoverContent className="border-input w-72 p-0" align="start">
            <Command>
               <CommandInput placeholder="Search agents…" />
               <CommandList>
                  <CommandEmpty>No agents in this workspace.</CommandEmpty>
                  <CommandGroup>
                     {agents.map((agent) => (
                        <CommandItem
                           key={agent.id}
                           value={`${agent.name} ${agent.id}`}
                           onSelect={() => {
                              onChange(agent);
                              setOpen(false);
                           }}
                           className="flex items-center justify-between"
                        >
                           <div className="flex min-w-0 items-center gap-2">
                              <Avatar className="size-5">
                                 <AvatarImage src={agent.avatarUrl ?? undefined} alt={agent.name} />
                                 <AvatarFallback>{agent.name.charAt(0)}</AvatarFallback>
                              </Avatar>
                              <span className="truncate">{agent.name}</span>
                           </div>
                           {leader?.id === agent.id && <CheckIcon size={16} className="ml-auto" />}
                        </CommandItem>
                     ))}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}
