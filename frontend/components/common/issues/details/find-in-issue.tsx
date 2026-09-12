'use client';

import { useShortcut } from '@/components/layout/shortcut-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Find within one task.
 *
 * The browser's own find is taken away by the app shell the moment a dialog or
 * a drawer owns focus, and it cannot see a long description that has been
 * scrolled out of view inside a pane. This searches the task's own pane and
 * steps between matches.
 *
 * Highlighting uses the CSS Custom Highlight API, which paints ranges without
 * touching the DOM. That matters: wrapping matches in elements would rewrite a
 * tree React owns, and the next render would either lose the highlight or lose
 * the edit someone was typing.
 */

interface HighlightRegistry {
   set: (name: string, highlight: unknown) => void;
   delete: (name: string) => void;
}

interface HighlightConstructor {
   new (...ranges: Range[]): unknown;
}

const HIGHLIGHT_NAME = 'berry-find';

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
   if (typeof window === 'undefined') return null;
   const scope = window as unknown as {
      CSS?: { highlights?: HighlightRegistry };
      Highlight?: HighlightConstructor;
   };
   if (!scope.CSS?.highlights || !scope.Highlight) return null;
   return { registry: scope.CSS.highlights, Highlight: scope.Highlight };
}

/** Every match for `query` under `root`, in document order. */
function findRanges(root: HTMLElement, query: string): Range[] {
   const needle = query.toLowerCase();
   if (!needle) return [];
   const ranges: Range[] = [];
   const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
         const parent = node.parentElement;
         if (!parent) return NodeFilter.FILTER_REJECT;
         // Skip what the reader cannot see, and the find bar's own input.
         if (parent.closest('[data-find-bar]')) return NodeFilter.FILTER_REJECT;
         if (parent.closest('[hidden]')) return NodeFilter.FILTER_REJECT;
         return node.nodeValue && node.nodeValue.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
      },
   });

   let node = walker.nextNode();
   while (node) {
      const text = (node.nodeValue ?? '').toLowerCase();
      let from = text.indexOf(needle);
      while (from !== -1) {
         const range = document.createRange();
         range.setStart(node, from);
         range.setEnd(node, from + needle.length);
         ranges.push(range);
         from = text.indexOf(needle, from + needle.length);
      }
      node = walker.nextNode();
   }
   return ranges;
}

export function FindInIssue({ scope }: { scope: RefObject<HTMLElement | null> }) {
   const t = useTranslations('issueDetail.find');
   const [open, setOpen] = useState(false);
   const [query, setQuery] = useState('');
   const [ranges, setRanges] = useState<Range[]>([]);
   const [index, setIndex] = useState(0);
   const field = useRef<HTMLInputElement>(null);

   const clear = useCallback(() => {
      highlightApi()?.registry.delete(HIGHLIGHT_NAME);
   }, []);

   // mod+F, claimed from the shell's registry so it is one rebindable row in
   // settings rather than a listener nobody can find. Taken from the browser
   // deliberately: inside a task, "find" means this, and a reader who wants
   // the browser's own can press it twice. Only while a task is on screen —
   // this component mounts with the task and hands the action back with it.
   useShortcut('issue.find', () => {
      setOpen(true);
      requestAnimationFrame(() => field.current?.focus());
   });

   useEffect(() => {
      const root = scope.current;
      if (!open || !root || !query.trim()) {
         clear();
         setRanges([]);
         return;
      }
      const found = findRanges(root, query.trim());
      setRanges(found);
      setIndex((current) => (found.length === 0 ? 0 : Math.min(current, found.length - 1)));
      const api = highlightApi();
      if (api && found.length > 0) api.registry.set(HIGHLIGHT_NAME, new api.Highlight(...found));
      else clear();
   }, [open, query, scope, clear]);

   useEffect(() => clear, [clear]);

   const go = useCallback(
      (delta: number) => {
         if (ranges.length === 0) return;
         const next = (index + delta + ranges.length) % ranges.length;
         setIndex(next);
         const target = ranges[next]?.startContainer.parentElement;
         target?.scrollIntoView({ block: 'center' });
      },
      [ranges, index]
   );

   const close = useCallback(() => {
      setOpen(false);
      setQuery('');
      clear();
   }, [clear]);

   if (!open) return null;

   return (
      <div
         data-find-bar
         className="absolute right-4 top-3 z-20 flex items-center gap-1 rounded-sm border border-border bg-popover p-1 shadow-md"
      >
         {/* The highlight only has a colour if the page gives it one, and this
             is the only component that paints it. */}
         <style>{`::highlight(${HIGHLIGHT_NAME}) { background-color: color-mix(in oklab, var(--status-warning) 45%, transparent); }`}</style>
         <Input
            ref={field}
            value={query}
            aria-label={t('placeholder')}
            placeholder={t('placeholder')}
            className="h-7 w-48 border-0 bg-transparent shadow-none focus-visible:ring-0"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
               if (event.key === 'Escape') {
                  event.preventDefault();
                  close();
               }
               if (event.key === 'Enter') {
                  event.preventDefault();
                  go(event.shiftKey ? -1 : 1);
               }
            }}
         />
         <span className="shrink-0 px-1 tabular-nums text-muted-foreground">
            {ranges.length === 0
               ? query.trim()
                  ? t('none')
                  : ''
               : t('count', { index: index + 1, total: ranges.length })}
         </span>
         <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('previous')}
            disabled={ranges.length === 0}
            onClick={() => go(-1)}
         >
            <ChevronUp className="size-3.5" />
         </Button>
         <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('next')}
            disabled={ranges.length === 0}
            onClick={() => go(1)}
         >
            <ChevronDown className="size-3.5" />
         </Button>
         <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t('close')}
            onClick={close}
         >
            <X className="size-3.5" />
         </Button>
      </div>
   );
}

export default FindInIssue;
