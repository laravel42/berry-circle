'use client';

import { Fragment, type ReactNode } from 'react';

/**
 * The small subset of Markdown an agent actually writes back.
 *
 * Parsed to React elements rather than to HTML: a reply is text a model
 * produced, so there is no version of this that may reach
 * `dangerouslySetInnerHTML`. Everything unrecognised stays as the characters
 * that were written, which is the right failure for a chat message — a stray
 * asterisk should look like a stray asterisk, not swallow a paragraph.
 *
 * Deliberately not a full implementation. Tables, footnotes and reference
 * links do not appear in replies often enough to justify the parser they need,
 * and a half-working table is worse than a visible pipe character.
 */

const FENCE = /^```(\w+)?\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/** `code`, **bold**, *italic*, [text](url), and bare links, in one pass. */
const INLINE =
   /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<]+)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
   const nodes: ReactNode[] = [];
   let cursor = 0;
   let index = 0;
   for (const match of text.matchAll(INLINE)) {
      const at = match.index ?? 0;
      if (at > cursor) nodes.push(text.slice(cursor, at));
      const token = match[0];
      const key = `${keyPrefix}-${index}`;
      index += 1;

      if (token.startsWith('`')) {
         nodes.push(
            <code key={key} className="rounded bg-[var(--shell-line)] px-1 py-0.5 font-mono">
               {token.slice(1, -1)}
            </code>
         );
      } else if (token.startsWith('**')) {
         nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
      } else if (token.startsWith('*') || token.startsWith('_')) {
         nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
      } else if (token.startsWith('[')) {
         const label = token.slice(1, token.indexOf(']'));
         const href = match[6] ?? '';
         nodes.push(
            <a
               key={key}
               href={href}
               target="_blank"
               rel="noreferrer noopener"
               className="underline underline-offset-2"
            >
               {label}
            </a>
         );
      } else {
         nodes.push(
            <a
               key={key}
               href={token}
               target="_blank"
               rel="noreferrer noopener"
               className="underline underline-offset-2"
            >
               {token}
            </a>
         );
      }
      cursor = at + token.length;
   }
   if (cursor < text.length) nodes.push(text.slice(cursor));
   return nodes;
}

interface Block {
   kind: 'code' | 'heading' | 'list' | 'ordered' | 'quote' | 'paragraph';
   lines: string[];
   level?: number;
}

/** One pass over the lines, grouping them into the blocks above. */
function parse(source: string): Block[] {
   const blocks: Block[] = [];
   const lines = source.replace(/\r\n/g, '\n').split('\n');
   let fenced: Block | null = null;

   for (const line of lines) {
      if (fenced) {
         if (FENCE.test(line)) {
            blocks.push(fenced);
            fenced = null;
         } else {
            fenced.lines.push(line);
         }
         continue;
      }
      if (FENCE.test(line)) {
         fenced = { kind: 'code', lines: [] };
         continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
         blocks.push({
            kind: 'heading',
            lines: [heading[2] ?? ''],
            level: heading[1]?.length ?? 1,
         });
         continue;
      }

      const bullet = BULLET.exec(line);
      if (bullet) {
         const last = blocks.at(-1);
         if (last?.kind === 'list') last.lines.push(bullet[1] ?? '');
         else blocks.push({ kind: 'list', lines: [bullet[1] ?? ''] });
         continue;
      }

      const numbered = NUMBERED.exec(line);
      if (numbered) {
         const last = blocks.at(-1);
         if (last?.kind === 'ordered') last.lines.push(numbered[1] ?? '');
         else blocks.push({ kind: 'ordered', lines: [numbered[1] ?? ''] });
         continue;
      }

      const quote = QUOTE.exec(line);
      if (quote) {
         const last = blocks.at(-1);
         if (last?.kind === 'quote') last.lines.push(quote[1] ?? '');
         else blocks.push({ kind: 'quote', lines: [quote[1] ?? ''] });
         continue;
      }

      if (line.trim() === '') {
         // A blank line ends whatever was open; the next line starts fresh.
         blocks.push({ kind: 'paragraph', lines: [] });
         continue;
      }

      const last = blocks.at(-1);
      if (last?.kind === 'paragraph' && last.lines.length > 0) last.lines.push(line);
      else blocks.push({ kind: 'paragraph', lines: [line] });
   }

   if (fenced) blocks.push(fenced);
   return blocks.filter((block) => block.kind === 'code' || block.lines.length > 0);
}

export function ChatMarkdown({ body }: { body: string }) {
   const blocks = parse(body);

   return (
      <div className="flex flex-col gap-2">
         {blocks.map((block, index) => {
            const key = `block-${index}`;
            if (block.kind === 'code') {
               return (
                  <pre
                     key={key}
                     className="overflow-x-auto rounded-md bg-[var(--shell-line)] px-3 py-2 font-mono"
                  >
                     <code>{block.lines.join('\n')}</code>
                  </pre>
               );
            }
            if (block.kind === 'heading') {
               const text = inline(block.lines[0] ?? '', key);
               // Inside a message a heading is a section marker, not a page
               // title, so the scale tops out well below the page's own.
               return block.level === 1 ? (
                  <h3 key={key} className="font-medium">
                     {text}
                  </h3>
               ) : (
                  <h4 key={key} className="font-medium">
                     {text}
                  </h4>
               );
            }
            if (block.kind === 'list' || block.kind === 'ordered') {
               const items = block.lines.map((line, at) => (
                  <li key={`${key}-${at}`}>{inline(line, `${key}-${at}`)}</li>
               ));
               return block.kind === 'list' ? (
                  <ul key={key} className="list-disc pl-5">
                     {items}
                  </ul>
               ) : (
                  <ol key={key} className="list-decimal pl-5">
                     {items}
                  </ol>
               );
            }
            if (block.kind === 'quote') {
               return (
                  <blockquote
                     key={key}
                     className="border-l-2 border-[var(--shell-line-strong)] pl-3 text-[var(--shell-text-dim)]"
                  >
                     {block.lines.map((line, at) => (
                        <Fragment key={`${key}-${at}`}>
                           {inline(line, `${key}-${at}`)}
                           {at < block.lines.length - 1 ? <br /> : null}
                        </Fragment>
                     ))}
                  </blockquote>
               );
            }
            return (
               <p key={key} className="whitespace-pre-wrap break-words">
                  {block.lines.map((line, at) => (
                     <Fragment key={`${key}-${at}`}>
                        {inline(line, `${key}-${at}`)}
                        {at < block.lines.length - 1 ? <br /> : null}
                     </Fragment>
                  ))}
               </p>
            );
         })}
      </div>
   );
}
