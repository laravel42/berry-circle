'use client';

import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
   applyTextareaLink,
   applyTextareaWrap,
   commitTextareaEdit,
   getTextareaSelectionRect,
} from '@/lib/markdown-selection';
import { MarkdownDescription } from '@/components/common/issues/details/markdown-description';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FormatAction, SelectionFormatBar } from './selection-format-bar';

interface MarkdownPreviewTextareaProps extends Omit<React.ComponentProps<'textarea'>, 'onChange'> {
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

/**
 * Markdown description field: formatted read view, plain textarea while editing.
 * Avoids transparent-overlay mirroring, which misaligns when syntax changes width.
 */
export function MarkdownPreviewTextarea({
   value,
   onChange,
   className,
   onBlur,
   placeholder,
   ...props
}: MarkdownPreviewTextareaProps) {
   const textareaRef = useRef<HTMLTextAreaElement>(null);
   const [editing, setEditing] = useState(false);
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
      if (!editing) return;
      const textarea = textareaRef.current;
      if (!textarea) return;

      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);

      const onScroll = () => syncBar();

      textarea.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      document.addEventListener('scroll', onScroll, true);

      return () => {
         textarea.removeEventListener('scroll', onScroll);
         window.removeEventListener('resize', onScroll);
         document.removeEventListener('scroll', onScroll, true);
      };
   }, [editing, syncBar]);

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

   const startEditing = () => {
      setEditing(true);
   };

   const stopEditing = (event: React.FocusEvent<HTMLTextAreaElement>) => {
      window.setTimeout(() => setBar(null), 120);
      setEditing(false);
      onBlur?.(event);
   };

   if (!editing) {
      return (
         <button
            type="button"
            onClick={startEditing}
            onPointerDown={(event) => event.stopPropagation()}
            className={cn(
               'min-h-20 w-full cursor-text rounded-md px-0 py-1 text-left text-foreground outline-none',
               !value && 'text-sm text-foreground/40',
               className
            )}
         >
            {value ? (
               <MarkdownDescription text={value} />
            ) : (
               <span className="text-sm leading-6">{placeholder}</span>
            )}
         </button>
      );
   }

   return (
      <>
         <Textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onSelect={syncBar}
            onKeyUp={syncBar}
            onMouseUp={syncBar}
            onBlur={stopEditing}
            placeholder={placeholder}
            className={cn(
               'min-h-20 w-full resize-y border-none bg-transparent px-0 py-1 text-sm leading-6 text-foreground shadow-none outline-none placeholder:text-foreground/40',
               className
            )}
            {...props}
         />
         {value.trim() ? (
            <div className="mt-2 rounded-sm border border-border/50 bg-muted/20 px-3 py-2">
               <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Preview
               </p>
               <MarkdownDescription text={value} />
            </div>
         ) : null}
         <SelectionFormatBar
            open={bar !== null}
            top={bar?.top ?? 0}
            left={bar?.left ?? 0}
            onFormat={applyFormat}
         />
      </>
   );
}
