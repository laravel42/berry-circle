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
import { Status } from '@/data/status';
import { CheckIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { projectCreateStatusOptions } from './create-project/project-status-options';

const projectStatuses = projectCreateStatusOptions.map((option) => option.status);

interface StatusWithPercentProps {
   status: Status;
   percentComplete: number;
   onStatusChange?: (statusId: string) => void;
}

export function StatusWithPercent({
   status,
   percentComplete,
   onStatusChange,
}: StatusWithPercentProps) {
   const id = useId();
   const [open, setOpen] = useState<boolean>(false);
   const [value, setValue] = useState<string>(status.id);

   useEffect(() => {
      setValue(status.id);
   }, [status.id]);

   const handleStatusChange = (statusId: string) => {
      setValue(statusId);
      setOpen(false);

      if (onStatusChange) {
         onStatusChange(statusId);
      }
   };

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               id={id}
               className="flex items-center justify-center gap-1.5"
               size="sm"
               variant="ghost"
               role="combobox"
               aria-expanded={open}
            >
               {(() => {
                  const selectedItem = projectStatuses.find((item) => item.id === value);
                  if (selectedItem) {
                     const Icon = selectedItem.icon;
                     return <Icon />;
                  }
                  return null;
               })()}
               <span className="font-medium mt-[1px]">{percentComplete}%</span>
            </Button>
         </PopoverTrigger>
         <PopoverContent className="border-input w-48 p-0" align="start">
            <Command>
               <CommandList>
                  <CommandEmpty>No status found.</CommandEmpty>
                  <CommandGroup>
                     {projectStatuses.map((item) => {
                        const Icon = item.icon;
                        return (
                           <CommandItem
                              key={item.id}
                              value={item.id}
                              onSelect={handleStatusChange}
                              className="flex items-center justify-between"
                           >
                              <div className="flex items-center gap-2">
                                 <Icon />
                                 <span>{item.name}</span>
                              </div>
                              {value === item.id && <CheckIcon size={14} className="ml-auto" />}
                           </CommandItem>
                        );
                     })}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}
