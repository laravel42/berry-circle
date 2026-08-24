'use client';

import { InlineText } from './content-blocks';

function FormattedMirrorLine({ line }: { line: string }) {
   if (!line) {
      return <span className="inline-block min-h-[1.5rem]">&nbsp;</span>;
   }

   return (
      <span className="inline-block min-h-[1.5rem] text-foreground/90">
         <InlineText text={line} />
      </span>
   );
}

/** Line-by-line formatted mirror for transparent textarea overlay. */
export function MarkdownFormattedMirror({ text }: { text: string }) {
   const lines = text.split('\n');

   return (
      <div className="whitespace-pre-wrap break-words text-sm leading-6">
         {lines.map((line, index) => (
            <div key={index}>
               <FormattedMirrorLine line={line} />
            </div>
         ))}
      </div>
   );
}

/** Render issue description markdown with inline formatting. */
export function MarkdownDescription({ text }: { text: string }) {
   const lines = text.split('\n');

   return (
      <div className="text-sm leading-6">
         {lines.map((line, index) => {
            if (!line.trim()) {
               return <div key={index} className="h-2" aria-hidden />;
            }

            return (
               <p key={index} className="my-1.5 text-foreground/90 first:mt-0 last:mb-0">
                  <InlineText text={line} />
               </p>
            );
         })}
      </div>
   );
}
