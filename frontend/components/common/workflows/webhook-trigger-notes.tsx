'use client';

import { Button } from '@/components/ui/button';
import { absoluteApiUrl } from '@/lib/api';
import { WEBHOOK_DELIVERY_FIELDS, workflowHookPath } from '@/lib/workflows';
import { cn } from '@/lib/utils';
import { useState } from 'react';
import { UrlBox } from './copy-button';
import { WorkflowWebhookDialog } from './workflow-webhook-dialog';

/** What each delivery becomes under `trigger`, for anyone writing the steps that read it. */
export function WebhookDeliveryContract({ className }: { className?: string }) {
   return (
      <dl className={cn('grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1', className)}>
         {WEBHOOK_DELIVERY_FIELDS.map((entry) => (
            <div key={entry.field} className="contents">
               <dt className="font-mono">{entry.field}</dt>
               <dd className="text-muted-foreground">{entry.meaning}</dd>
            </div>
         ))}
      </dl>
   );
}

interface WebhookTriggerNotesProps {
   /** The workflow the hook belongs to; absent while it is still being created. */
   workflowId?: string;
   /** Stack the rows, for a narrow panel. */
   compact?: boolean;
   className?: string;
}

/**
 * The webhook trigger's configuration: where deliveries go, what they turn
 * into, and the one action there is — rotating the secret that completes
 * the URL. Only a digest of the token is stored, so the URL is shown with
 * a placeholder until a rotation reveals a fresh one.
 */
export function WebhookTriggerNotes({
   workflowId,
   compact = false,
   className,
}: WebhookTriggerNotesProps) {
   const [rotating, setRotating] = useState(false);
   return (
      <div className={cn('flex min-w-0 flex-col gap-3', className)}>
         <div className="flex min-w-0 flex-col gap-1">
            <span className="text-muted-foreground">Hook URL</span>
            {workflowId ? (
               <>
                  <UrlBox label="hook URL" url={absoluteApiUrl(workflowHookPath(workflowId))} />
                  <p className="text-muted-foreground">
                     <code className="font-mono">{'{token}'}</code> is the secret: rotate it to get
                     a URL that works, then POST a JSON body to it while the workflow is active.
                     Each workflow accepts 60 deliveries a minute.
                  </p>
               </>
            ) : (
               <p className="text-muted-foreground">
                  The URL appears on the workflow page once it is created; rotate the secret there
                  to complete it.
               </p>
            )}
         </div>
         <div className="flex min-w-0 flex-col gap-1">
            <span className="text-muted-foreground">Each delivery becomes</span>
            <WebhookDeliveryContract className={cn(compact && 'grid-cols-1 gap-y-0.5')} />
         </div>
         {workflowId && (
            <div>
               <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  onClick={() => setRotating(true)}
               >
                  Rotate secret
               </Button>
               <WorkflowWebhookDialog
                  workflowId={workflowId}
                  open={rotating}
                  onOpenChange={setRotating}
               />
            </div>
         )}
      </div>
   );
}
