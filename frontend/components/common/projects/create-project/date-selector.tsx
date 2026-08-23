'use client';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { format } from 'date-fns';
import { Calendar as CalendarIcon } from 'lucide-react';
import { useId, useState } from 'react';

interface ProjectDateSelectorProps {
   label: string;
   date?: Date;
   onChange: (date: Date | undefined) => void;
}

export function ProjectDateSelector({ label, date, onChange }: ProjectDateSelectorProps) {
   const id = useId();
   const [open, setOpen] = useState(false);
   const formatted = date ? format(date, 'MMM d') : label;

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               id={id}
               className={date ? undefined : 'text-muted-foreground'}
               size="xs"
               variant="secondary"
               aria-expanded={open}
               aria-label={date ? `${label}: ${format(date, 'MMM d, yyyy')}` : label}
            >
               <CalendarIcon className="size-3.5" />
               <span>{formatted}</span>
            </Button>
         </PopoverTrigger>
         <PopoverContent className="w-auto p-0" align="start">
            <Calendar
               mode="single"
               selected={date}
               onSelect={(next) => {
                  onChange(next);
                  setOpen(false);
               }}
               initialFocus
            />
            {date ? (
               <div className="border-t p-2">
                  <Button
                     type="button"
                     variant="ghost"
                     size="xs"
                     className="w-full"
                     onClick={() => {
                        onChange(undefined);
                        setOpen(false);
                     }}
                  >
                     Clear date
                  </Button>
               </div>
            ) : null}
         </PopoverContent>
      </Popover>
   );
}
