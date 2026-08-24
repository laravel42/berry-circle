'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Plate, PlateContent, usePlateEditor } from 'platejs/react';
import { BasicBlocksPlugin, BasicMarksPlugin } from '@platejs/basic-nodes/react';
import { ListPlugin } from '@platejs/list/react';
import { MarkdownPlugin } from '@platejs/markdown';

import { cn } from '@/lib/utils';

interface RichDescriptionEditorProps {
   /** Markdown. The editor reads and writes this, never a Plate-native value. */
   value: string;
   /** Fired with markdown when editing settles, not on every keystroke. */
   onCommit?: (markdown: string) => void;
   /**
    * Fired with markdown on every change. Only for form fields whose value is
    * submitted by a button — a click blurs the editor, but relying on that
    * ordering to capture the last keystroke is a race worth avoiding.
    */
   onChange?: (markdown: string) => void;
   placeholder?: string;
   className?: string;
   readOnly?: boolean;
   'aria-label'?: string;
}

/**
 * Shared rich-text editor for description fields.
 *
 * Markdown stays the storage format. Every description in Berry is already
 * markdown in PostgreSQL, is rendered as markdown elsewhere, and — for agents —
 * is round-tripped through OpenFang, which has no notion of Plate's value
 * shape. Storing Plate JSON would strand existing content and make the field
 * unreadable to anything but this editor, so the editor deserialises markdown
 * in and serialises markdown out.
 *
 * The cost is that markdown is the ceiling: anything markdown cannot express is
 * lost on save. That is the right trade here — these are descriptions, not
 * documents — but it is why only markdown-expressible blocks are enabled.
 *
 * Round-tripping was verified across paragraphs, headings, marks, both list
 * kinds, quotes, and code blocks. The one difference is bullet markers, which
 * normalise from `-` to `*` — the same markdown, rendered identically.
 */
export function RichDescriptionEditor({
   value,
   onCommit,
   onChange,
   placeholder,
   className,
   readOnly = false,
   'aria-label': ariaLabel,
}: RichDescriptionEditorProps) {
   // The React plugin variants, not the Base* ones. Base* are headless and
   // exist for serialising outside React; in an editor they register no node
   // renderers, so blocks and marks have nothing to draw with and the surface
   // comes up inert.
   //
   // ListPlugin is not optional either: without it the markdown round trip
   // drops list content entirely rather than degrading it, so a description
   // with bullets would save as empty.
   const plugins = useMemo(
      () => [BasicBlocksPlugin, BasicMarksPlugin, ListPlugin, MarkdownPlugin],
      []
   );

   const editor = usePlateEditor({
      plugins,
      // Initial content only. Plate owns the document after mount, so rebuilding
      // it from props on every render would fight the user's cursor.
      value: (instance) => instance.getApi(MarkdownPlugin).markdown.deserialize(value),
   });

   // What the caller last persisted, so blur can tell a real edit from a
   // focus-and-leave and skip a pointless write.
   const committedRef = useRef(value);

   // usePlateEditor reads `value` once, at mount. Anything that changes it
   // afterwards — switching to another agent in the same drawer, or a refetch
   // after save — would otherwise leave the previous document on screen.
   //
   // Only applied while unfocused: replacing blocks under an active cursor
   // would discard what is being typed.
   useEffect(() => {
      if (value === committedRef.current) return;
      if (editor.api.isFocused()) return;
      committedRef.current = value;
      const api = editor.getApi(MarkdownPlugin).markdown;
      editor.tf.setValue(api.deserialize(value));
   }, [editor, value]);

   const commit = useCallback(() => {
      if (readOnly || !onCommit) return;
      const markdown = editor.getApi(MarkdownPlugin).markdown.serialize().trim();
      if (markdown === committedRef.current.trim()) return;
      committedRef.current = markdown;
      onCommit(markdown);
   }, [editor, onCommit, readOnly]);

   const handleChange = useCallback(() => {
      if (readOnly || !onChange) return;
      onChange(editor.getApi(MarkdownPlugin).markdown.serialize());
   }, [editor, onChange, readOnly]);

   return (
      <Plate editor={editor} onChange={onChange ? handleChange : undefined}>
         <PlateContent
            readOnly={readOnly}
            placeholder={placeholder}
            aria-label={ariaLabel}
            onBlur={commit}
            // The drawer and dialog surfaces this sits in drag or close on
            // pointer events; without this, selecting text moves the panel.
            onPointerDown={(event) => event.stopPropagation()}
            className={cn(
               'min-h-24 w-full rounded-md px-0 py-1 text-sm leading-6 outline-none',
               '[&_[data-slate-placeholder]]:text-muted-foreground',
               '[&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-medium',
               '[&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-medium',
               '[&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-medium',
               '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3',
               '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.85em]',
               '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5',
               readOnly && 'cursor-default',
               className
            )}
         />
      </Plate>
   );
}
