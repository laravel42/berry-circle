'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
   Bold,
   Code2,
   Italic,
   Link2,
   Strikethrough,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { createPortal } from 'react-dom';

export type FormatAction = 'bold' | 'italic' | 'strike' | 'code' | 'link';

interface SelectionFormatBarProps {
   open: boolean;
   top: number;
   left: number;
   onFormat: (action: FormatAction) => void;
}

const ACTIONS: { id: FormatAction; label: string; icon: ComponentType<{ className?: string }> }[] =
   [
      { id: 'bold', label: 'Bold', icon: Bold },
      { id: 'italic', label: 'Italic', icon: Italic },
      { id: 'strike', label: 'Strikethrough', icon: Strikethrough },
      { id: 'code', label: 'Code', icon: Code2 },
      { id: 'link', label: 'Link', icon: Link2 },
   ];

export function SelectionFormatBar({ open, top, left, onFormat }: SelectionFormatBarProps) {
   if (!open || typeof document === 'undefined') return null;

   return createPortal(
      <div
         role="toolbar"
         aria-label="Text formatting"
         className={cn(
            'fixed z-[200] flex items-center gap-0.5 rounded-lg border border-border/80 bg-popover p-0.5 shadow-lg',
            'animate-in fade-in-0 zoom-in-95 duration-100'
         )}
         style={{
            top: Math.max(8, top),
            left,
            transform: 'translate(-50%, -100%) translateY(-8px)',
         }}
         onMouseDown={(event) => event.preventDefault()}
      >
         {ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
               <Button
                  key={action.id}
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground hover:text-foreground"
                  aria-label={action.label}
                  onMouseDown={(event) => {
                     event.preventDefault();
                     onFormat(action.id);
                  }}
               >
                  <Icon className="size-3.5" />
               </Button>
            );
         })}
      </div>,
      document.body
   );
}
