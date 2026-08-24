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
import { priorities, type Priority } from '@/data/priorities';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

interface ProjectPrioritySelectorProps {
   priority: Priority;
   onChange: (priority: Priority) => void;
}

export function ProjectPrioritySelector({ priority, onChange }: ProjectPrioritySelectorProps) {
   const id = useId();
   const [open, setOpen] = useState(false);
   const [value, setValue] = useState(priority.id);

   useEffect(() => {
      setValue(priority.id);
   }, [priority.id]);

   const handleChange = (priorityId: string) => {
      setValue(priorityId);
      setOpen(false);
      const next = priorities.find((entry) => entry.id === priorityId);
      if (next) {
         onChange(next);
      }
   };

   const selected = priorities.find((entry) => entry.id === value);

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               id={id}
               className={
                  selected?.id === 'no-priority'
                     ? 'flex items-center justify-center text-muted-foreground'
                     : 'flex items-center justify-center'
               }
               size="xs"
               variant="secondary"
               role="combobox"
               aria-expanded={open}
            >
               {selected && <selected.icon className="text-muted-foreground size-4" />}
               <span>{selected?.name ?? 'No priority'}</span>
            </Button>
         </PopoverTrigger>
         <PopoverContent
            className="border-input w-full min-w-[var(--radix-popper-anchor-width)] p-0"
            align="start"
         >
            <Command>
               <CommandList>
                  <CommandEmpty>No priority found.</CommandEmpty>
                  <CommandGroup>
                     {priorities.map((item) => (
                        <CommandItem
                           key={item.id}
                           value={item.id}
                           onSelect={() => handleChange(item.id)}
                           className="flex items-center justify-between"
                        >
                           <div className="flex items-center gap-2">
                              <item.icon className="text-muted-foreground size-4" />
                              {item.name}
                           </div>
                           {value === item.id && <CheckIcon size={16} className="ml-auto" />}
                        </CommandItem>
                     ))}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}
