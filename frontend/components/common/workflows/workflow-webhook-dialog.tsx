'use client';

import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { apiUrl } from '@/lib/api';
import type { WebhookSecret } from '@/lib/workflows';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useWorkflowActions } from './use-workflow-actions';

interface WorkflowWebhookDialogProps {
   workflowId: string;
   open: boolean;
   onOpenChange: (open: boolean) => void;
}

function CopyButton({ label, text }: { label: string; text: string }) {
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

/**
 * Rotate the hook secret and show it once. Only a digest is stored, so the
 * secret leaves this dialog by the copy button or not at all; closing it
 * forgets the value, and a person who missed it rotates again.
 */
export function WorkflowWebhookDialog({
   workflowId,
   open,
   onOpenChange,
}: WorkflowWebhookDialogProps) {
   const { busy, rotateWebhook } = useWorkflowActions(workflowId);
   const [secret, setSecret] = useState<WebhookSecret | null>(null);

   useEffect(() => {
      if (!open) setSecret(null);
   }, [open]);

   const absoluteUrl = (path: string) => {
      const resolved = apiUrl(path);
      if (/^https?:/i.test(resolved)) return resolved;
      return typeof window !== 'undefined' ? `${window.location.origin}${resolved}` : resolved;
   };

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="sm:max-w-lg">
            <DialogHeader>
               <DialogTitle>Webhook secret</DialogTitle>
               <DialogDescription>
                  Deliveries to the hook URL start a run of this workflow while it is active. The
                  secret is part of the URL and is shown once; rotating it invalidates the previous
                  one immediately.
               </DialogDescription>
            </DialogHeader>
            {secret ? (
               <div className="flex flex-col gap-3">
                  <div>
                     <p className="mb-1 text-muted-foreground">Hook URL</p>
                     <div className="flex items-start gap-2">
                        <code className="min-w-0 flex-1 break-all rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 font-mono">
                           {absoluteUrl(secret.url)}
                        </code>
                        <CopyButton label="hook URL" text={absoluteUrl(secret.url)} />
                     </div>
                  </div>
                  <div>
                     <p className="mb-1 text-muted-foreground">Secret</p>
                     <div className="flex items-start gap-2">
                        <code className="min-w-0 flex-1 break-all rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 font-mono">
                           {secret.secret}
                        </code>
                        <CopyButton label="secret" text={secret.secret} />
                     </div>
                  </div>
                  <p role="status" className="text-status-warning">
                     Copy it now. It will not be shown again.
                  </p>
               </div>
            ) : (
               <p className="text-muted-foreground">
                  No secret is shown until you rotate. Anything already using the previous URL stops
                  working once you do.
               </p>
            )}
            <DialogFooter>
               <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                  {secret ? 'Done' : 'Cancel'}
               </Button>
               {!secret && (
                  <Button
                     type="button"
                     size="sm"
                     disabled={busy === 'rotating'}
                     onClick={() => {
                        void rotateWebhook().then((result) => {
                           if (result) setSecret(result);
                        });
                     }}
                  >
                     {busy === 'rotating' ? 'Rotating…' : 'Rotate secret'}
                  </Button>
               )}
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
