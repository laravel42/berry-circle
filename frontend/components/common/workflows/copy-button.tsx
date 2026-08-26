'use client';

import { Button } from '@/components/ui/button';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

/** Copies one string to the clipboard and says so for a moment. */
export function CopyButton({ label, text }: { label: string; text: string }) {
   const [copied, setCopied] = useState(false);
   return (
      <Button
         type="button"
         size="xs"
         variant="secondary"
         aria-label={`Copy ${label}`}
         onClick={() => {
            void navigator.clipboard
               .writeText(text)
               .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
               })
               .catch(() => toast.error('Could not access the clipboard'));
         }}
      >
         {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
         {copied ? 'Copied' : 'Copy'}
      </Button>
   );
}

/** A URL in a box with its copy button beside it. */
export function UrlBox({ label, url }: { label: string; url: string }) {
   return (
      <div className="flex items-start gap-2">
         <code
            className="min-w-0 flex-1 break-all rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 font-mono"
            aria-label={label}
         >
            {url}
         </code>
         <CopyButton label={label} text={url} />
      </div>
   );
}
