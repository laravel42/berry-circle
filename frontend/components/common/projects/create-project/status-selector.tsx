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
import type { Status } from '@/data/status';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { projectCreateStatusOptions } from './project-status-options';

interface ProjectStatusSelectorProps {
   status: Status;
   onChange: (status: Status) => void;
}

export function ProjectStatusSelector({ status, onChange }: ProjectStatusSelectorProps) {
   const id = useId();
   const [open, setOpen] = useState(false);
   const [value, setValue] = useState(status.id);

   useEffect(() => {
      setValue(status.id);
   }, [status.id]);

   const selected = projectCreateStatusOptions.find((option) => option.status.id === value);

   const handleChange = (statusId: string) => {
      setValue(statusId);
      setOpen(false);
      const next = projectCreateStatusOptions.find((option) => option.status.id === statusId);
      if (next) {
         onChange(next.status);
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
               {selected && <selected.status.icon />}
               <span>{selected?.label ?? 'Planned'}</span>
            </Button>
         </PopoverTrigger>
         <PopoverContent
            className="border-input w-full min-w-[var(--radix-popper-anchor-width)] p-0"
            align="start"
         >
            <Command>
               <CommandList>
                  <CommandEmpty>No status found.</CommandEmpty>
                  <CommandGroup>
                     {projectCreateStatusOptions.map((option) => (
                        <CommandItem
                           key={option.status.id}
                           value={option.status.id}
                           onSelect={() => handleChange(option.status.id)}
                           className="flex items-center justify-between"
                        >
                           <div className="flex items-center gap-2">
                              <option.status.icon />
                              {option.label}
                           </div>
                           {value === option.status.id && <CheckIcon size={16} className="ml-auto" />}
                        </CommandItem>
                     ))}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}
