'use client';

import { EditorAiBar } from '@/components/common/editor/editor-ai-bar';
import { Button } from '@/components/ui/button';
import { assistEditorText } from '@/lib/editor-ai';
import { BerryApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { BubbleMenu, EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Code, Italic, Link2, Strikethrough } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from 'tiptap-markdown';

interface TiptapAiEditorProps {
   /** Markdown text stored by the form. */
   value: string;
   /** Fired with markdown on every editor update. */
   onChange: (markdown: string) => void;
   placeholder?: string;
   className?: string;
   'aria-label'?: string;
   'data-heading'?: 'h1' | 'h2' | 'h3';
   /**
    * The AI assist bar under the text. On by default; a form that wants plain
    * prose turns it off, and the space the bar reserved goes with it.
    */
   aiAssist?: boolean;
}

type TipTapEditor = NonNullable<ReturnType<typeof useEditor>>;

function readMarkdown(editor: TipTapEditor): string {
   return editor.storage.markdown.getMarkdown() as string;
}

export function TiptapAiEditor({
   value,
   onChange,
   placeholder,
   className,
   'aria-label': ariaLabel,
   'data-heading': dataHeading,
   aiAssist = true,
}: TiptapAiEditorProps) {
   const [aiPrompt, setAiPrompt] = useState('');
   const [aiPending, setAiPending] = useState(false);
   const focusedRef = useRef(false);

   const editor = useEditor({
      extensions: [
         StarterKit,
         Placeholder.configure({ placeholder: placeholder ?? '' }),
         Link.configure({ openOnClick: false, autolink: true }),
         Markdown.configure({
            html: false,
            transformPastedText: true,
            transformCopiedText: true,
         }),
      ],
      content: value,
      immediatelyRender: false,
      editorProps: {
         attributes: {
            class: 'outline-none',
            ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
            ...(dataHeading ? { 'data-heading': dataHeading } : {}),
         },
      },
      onUpdate: ({ editor: current }) => {
         onChange(readMarkdown(current));
      },
      onFocus: () => {
         focusedRef.current = true;
      },
      onBlur: () => {
         focusedRef.current = false;
      },
   });

   useEffect(() => {
      if (!editor || focusedRef.current) return;
      const current = readMarkdown(editor);
      if (current !== value) {
         editor.commands.setContent(value);
      }
   }, [editor, value]);

   const runAssist = useCallback(
      async (instruction: string) => {
         if (!editor || aiPending) return;
         const trimmedInstruction = instruction.trim();
         if (!trimmedInstruction) return;

         const { from, to } = editor.state.selection;
         const selected =
            from !== to ? editor.state.doc.textBetween(from, to, '\n\n').trim() : '';
         const source = selected || readMarkdown(editor).trim();
         if (!source) {
            toast.error('Write something to rewrite');
            return;
         }

         setAiPending(true);
         try {
            const rewritten = await assistEditorText({
               text: source,
               instruction: `${trimmedInstruction}\n\nReturn Markdown only.`,
            });
            if (selected) {
               editor
                  .chain()
                  .focus()
                  .deleteRange({ from, to })
                  .insertContent(rewritten)
                  .run();
            } else {
               editor.commands.setContent(rewritten);
            }
            onChange(readMarkdown(editor));
         } catch (error) {
            toast.error(error instanceof BerryApiError ? error.message : 'Could not rewrite text');
         } finally {
            setAiPending(false);
         }
      },
      [aiPending, editor, onChange]
   );

   const setLink = useCallback(() => {
      if (!editor) return;
      const previousUrl = editor.getAttributes('link').href as string | undefined;
      const url = window.prompt('Link URL', previousUrl ?? 'https://');
      if (url === null) return;
      if (url.trim() === '') {
         editor.chain().focus().extendMarkRange('link').unsetLink().run();
         return;
      }
      editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
   }, [editor]);

   if (!editor) {
      return (
         <div
            className={cn('tiptap-ai-editor text-muted-foreground min-h-24', className)}
            data-heading={dataHeading}
         >
            {placeholder}
         </div>
      );
   }

   return (
      <div
         className={cn('tiptap-ai-editor relative flex min-h-0 flex-1 flex-col', className)}
         onPointerDown={(event) => event.stopPropagation()}
      >
         <BubbleMenu
            editor={editor}
            tippyOptions={{ duration: 100 }}
            className="bg-popover text-popover-foreground border-border flex items-center gap-0.5 rounded-md border p-1 shadow-md"
         >
            <Button
               type="button"
               variant={editor.isActive('bold') ? 'secondary' : 'ghost'}
               size="icon"
               className="size-7"
               aria-label="Bold"
               onClick={() => editor.chain().focus().toggleBold().run()}
            >
               <Bold className="size-3.5" />
            </Button>
            <Button
               type="button"
               variant={editor.isActive('italic') ? 'secondary' : 'ghost'}
               size="icon"
               className="size-7"
               aria-label="Italic"
               onClick={() => editor.chain().focus().toggleItalic().run()}
            >
               <Italic className="size-3.5" />
            </Button>
            <Button
               type="button"
               variant={editor.isActive('strike') ? 'secondary' : 'ghost'}
               size="icon"
               className="size-7"
               aria-label="Strikethrough"
               onClick={() => editor.chain().focus().toggleStrike().run()}
            >
               <Strikethrough className="size-3.5" />
            </Button>
            <Button
               type="button"
               variant={editor.isActive('code') ? 'secondary' : 'ghost'}
               size="icon"
               className="size-7"
               aria-label="Code"
               onClick={() => editor.chain().focus().toggleCode().run()}
            >
               <Code className="size-3.5" />
            </Button>
            <Button
               type="button"
               variant={editor.isActive('link') ? 'secondary' : 'ghost'}
               size="icon"
               className="size-7"
               aria-label="Link"
               onClick={setLink}
            >
               <Link2 className="size-3.5" />
            </Button>
         </BubbleMenu>
         <EditorContent editor={editor} className={cn('min-h-24 flex-1', aiAssist && 'pb-16')} />
         {aiAssist ? (
            <EditorAiBar
               prompt={aiPrompt}
               onPromptChange={setAiPrompt}
               onPreset={(instruction) => void runAssist(instruction)}
               onSubmit={() => {
                  const instruction = aiPrompt.trim();
                  if (!instruction) return;
                  void runAssist(instruction).then(() => setAiPrompt(''));
               }}
               pending={aiPending}
            />
         ) : null}
      </div>
   );
}
