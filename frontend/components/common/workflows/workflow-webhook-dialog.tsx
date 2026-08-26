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
import { absoluteApiUrl } from '@/lib/api';
import type { WebhookSecret } from '@/lib/workflows';
import { useEffect, useState } from 'react';
import { CopyButton } from './copy-button';
import { useWorkflowActions } from './use-workflow-actions';

interface WorkflowWebhookDialogProps {
   workflowId: string;
   open: boolean;
   onOpenChange: (open: boolean) => void;
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
                           {absoluteApiUrl(secret.url)}
                        </code>
                        <CopyButton label="hook URL" text={absoluteApiUrl(secret.url)} />
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
