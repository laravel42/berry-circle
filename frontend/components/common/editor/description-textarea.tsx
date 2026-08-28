'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

interface DescriptionTextareaProps {
   /** The stored text. Markdown by convention, but edited and saved verbatim. */
   'value': string;
   /** Fired when editing settles, not on every keystroke. */
   'onCommit'?: (text: string) => void;
   /**
    * Fired on every keystroke. Only for form fields whose value is submitted by
    * a button — a click blurs the field, but relying on that ordering to capture
    * the last keystroke is a race worth avoiding.
    */
   'onChange'?: (text: string) => void;
   'placeholder'?: string;
   'className'?: string;
   'readOnly'?: boolean;
   'aria-label'?: string;
   /** Heading step to borrow the size of; see globals.css [data-heading]. */
   'data-heading'?: 'h1' | 'h2' | 'h3';
}

/**
 * Plain-text editor for description fields.
 *
 * Markdown remains the storage format — it is what PostgreSQL holds, what is
 * rendered elsewhere, and what the agent runtime round-trips — but it is
 * edited as raw text. The field therefore holds exactly the bytes that are
 * saved: nothing is parsed, normalised, escaped, or re-serialised between load
 * and save, so what a user reads is what the agent runtime receives.
 */
export function DescriptionTextarea({
   value,
   onCommit,
   onChange,
   placeholder,
   className,
   readOnly = false,
   'aria-label': ariaLabel,
   'data-heading': dataHeading,
}: DescriptionTextareaProps) {
   const [draft, setDraft] = useState(value);
   // Tracked so an external update cannot replace text mid-keystroke.
   const focusedRef = useRef(false);

   // Adopt changes that come from outside — switching to another agent in the
   // same drawer, or a refetch after a save — but never while the field is being
   // typed into, which would discard the edit in progress.
   useEffect(() => {
      if (focusedRef.current) return;
      setDraft(value);
   }, [value]);

   const commit = useCallback(() => {
      focusedRef.current = false;
      if (readOnly || !onCommit) return;
      // Raw text in, raw text out, so an untouched field compares equal and
      // writes nothing.
      if (draft === value) return;
      onCommit(draft);
   }, [draft, onCommit, readOnly, value]);

   return (
      <textarea
         value={draft}
         readOnly={readOnly}
         placeholder={placeholder}
         aria-label={ariaLabel}
         data-heading={dataHeading}
         onFocus={() => {
            focusedRef.current = true;
         }}
         onBlur={commit}
         onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            onChange?.(next);
         }}
         // The drawer and dialog surfaces this sits in drag or close on pointer
         // events; without this, selecting text moves the panel.
         onPointerDown={(event) => event.stopPropagation()}
         className={cn(
            'field-sizing-content min-h-24 w-full resize-none bg-transparent px-0 py-1 leading-6 outline-none',
            'placeholder:text-muted-foreground',
            readOnly && 'cursor-default',
            className
         )}
      />
   );
}
