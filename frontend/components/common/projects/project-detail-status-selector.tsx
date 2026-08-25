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
import { projectCreateStatusOptions } from './create-project/project-status-options';

interface ProjectDetailStatusSelectorProps {
   status: Status;
   onStatusChange: (status: Status) => void;
}

/** Icon-only status control for the project detail sidebar (matches issue StatusSelector). */
export function ProjectDetailStatusSelector({
   status,
   onStatusChange,
}: ProjectDetailStatusSelectorProps) {
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
      if (next) onStatusChange(next.status);
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               id={id}
               className="flex size-7 items-center justify-center"
               size="icon"
               variant="ghost"
               role="combobox"
               aria-expanded={open}
               aria-label={`Change status, current ${status.name}`}
            >
               {selected ? <selected.status.icon /> : null}
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
                           {value === option.status.id ? (
                              <CheckIcon size={16} className="ml-auto" />
                           ) : null}
                        </CommandItem>
                     ))}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}
