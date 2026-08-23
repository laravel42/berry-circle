'use client';

import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
   applyTextareaLink,
   applyTextareaWrap,
   commitTextareaEdit,
   getTextareaSelectionRect,
} from '@/lib/markdown-selection';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FormatAction, SelectionFormatBar } from './selection-format-bar';

interface MarkdownTextareaProps extends Omit<React.ComponentProps<'textarea'>, 'onChange'> {
   value: string;
   onChange: (value: string) => void;
}

const WRAP_BY_ACTION: Record<
   Exclude<FormatAction, 'link'>,
   { open: string; close: string; placeholder: string }
> = {
   bold: { open: '**', close: '**', placeholder: 'bold' },
   italic: { open: '*', close: '*', placeholder: 'italic' },
   strike: { open: '~~', close: '~~', placeholder: 'strike' },
   code: { open: '`', close: '`', placeholder: 'code' },
};

export function MarkdownTextarea({ value, onChange, className, onBlur, ...props }: MarkdownTextareaProps) {
   const textareaRef = useRef<HTMLTextAreaElement>(null);
   const [bar, setBar] = useState<{ top: number; left: number } | null>(null);

   const syncBar = useCallback(() => {
      const textarea = textareaRef.current;
      if (!textarea || textarea.selectionStart === textarea.selectionEnd) {
         setBar(null);
         return;
      }

      const rect = getTextareaSelectionRect(textarea);
      if (!rect) {
         setBar(null);
         return;
      }

      setBar({
         top: rect.top,
         left: rect.left + rect.width / 2,
      });
   }, []);

   useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const onScroll = () => syncBar();

      textarea.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      document.addEventListener('scroll', onScroll, true);

      return () => {
         textarea.removeEventListener('scroll', onScroll);
         window.removeEventListener('resize', onScroll);
         document.removeEventListener('scroll', onScroll, true);
      };
   }, [syncBar]);

   const applyFormat = useCallback(
      (action: FormatAction) => {
         const textarea = textareaRef.current;
         if (!textarea) return;

         const { selectionStart, selectionEnd } = textarea;
         const edit =
            action === 'link'
               ? applyTextareaLink(value, selectionStart, selectionEnd)
               : applyTextareaWrap(
                    value,
                    selectionStart,
                    selectionEnd,
                    WRAP_BY_ACTION[action].open,
                    WRAP_BY_ACTION[action].close,
                    WRAP_BY_ACTION[action].placeholder
                 );

         onChange(edit.value);
         requestAnimationFrame(() => {
            if (!textareaRef.current) return;
            commitTextareaEdit(textareaRef.current, edit);
            syncBar();
         });
      },
      [onChange, syncBar, value]
   );

   return (
      <>
         <Textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onSelect={syncBar}
            onKeyUp={syncBar}
            onMouseUp={syncBar}
            onBlur={(event) => {
               window.setTimeout(() => setBar(null), 120);
               onBlur?.(event);
            }}
            className={cn(className)}
            {...props}
         />
         <SelectionFormatBar
            open={bar !== null}
            top={bar?.top ?? 0}
            left={bar?.left ?? 0}
            onFormat={applyFormat}
         />
      </>
   );
}
