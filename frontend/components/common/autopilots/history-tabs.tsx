'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
   describeAutopilotFailure,
   describeReason,
   getWebhookDelivery,
   replayDelivery,
   type AutopilotRun,
   type WebhookDelivery,
} from '@/lib/autopilots';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
   if (status === 'enqueued' || status === 'accepted') return 'default';
   if (status === 'failed' || status === 'rejected') return 'destructive';
   if (status === 'skipped' || status === 'filtered') return 'secondary';
   return 'outline';
}

export function RunsTable({ runs, orgId }: { runs: AutopilotRun[]; orgId: string }) {
   if (runs.length === 0) {
      return <p className="px-6 py-6 text-muted-foreground">It has not run yet.</p>;
   }
   return (
      <div className="overflow-x-auto">
         <table className="w-full">
            <thead className="text-left text-muted-foreground">
               <tr className="border-b">
                  <th className="px-6 py-2 font-normal">When</th>
                  <th className="px-2 py-2 font-normal">Source</th>
                  <th className="px-2 py-2 font-normal">Outcome</th>
                  <th className="px-2 py-2 font-normal">Task</th>
                  <th className="px-2 py-2 font-normal">Version</th>
               </tr>
            </thead>
            <tbody>
               {runs.map((run) => (
                  <tr key={run.id} className="border-b">
                     <td className="px-6 py-2">{new Date(run.createdAt).toLocaleString()}</td>
                     <td className="px-2 py-2">{run.source}</td>
                     <td className="px-2 py-2">
                        <Badge variant={statusVariant(run.status)}>{run.status}</Badge>{' '}
                        <span
                           className="text-muted-foreground"
                           title={run.reasonMessage ?? undefined}
                        >
                           {describeReason(run.reasonCode)}
                           {run.taskStatus ? ` · task ${run.taskStatus}` : ''}
                        </span>
                     </td>
                     <td className="px-2 py-2">
                        {run.issueId ? (
                           <Link className="underline" href={`/${orgId}/issue/${run.issueId}`}>
                              open
                           </Link>
                        ) : (
                           <span className="text-muted-foreground">—</span>
                        )}
                     </td>
                     <td className="px-2 py-2 text-muted-foreground">v{run.autopilotVersion}</td>
                  </tr>
               ))}
            </tbody>
         </table>
      </div>
   );
}

export function DeliveriesTable({
   autopilotId,
   deliveries,
   onReplayed,
}: {
   autopilotId: string;
   deliveries: WebhookDelivery[];
   onReplayed: () => void;
}) {
   const [openId, setOpenId] = useState<string | null>(null);
   const [payload, setPayload] = useState<string>('');

   async function togglePayload(deliveryId: string) {
      if (openId === deliveryId) {
         setOpenId(null);
         return;
      }
      try {
         const detail = await getWebhookDelivery(autopilotId, deliveryId);
         setPayload(
            detail.payload === null
               ? '(no payload stored)'
               : JSON.stringify(detail.payload, null, 2)
         );
         setOpenId(deliveryId);
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   }

   async function replay(deliveryId: string) {
      try {
         const outcome = await replayDelivery(autopilotId, deliveryId);
         toast.success(`Replayed — ${outcome.status}`);
         onReplayed();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   }

   if (deliveries.length === 0) {
      return <p className="px-6 py-6 text-muted-foreground">No webhook deliveries yet.</p>;
   }
   return (
      <div className="overflow-x-auto">
         <table className="w-full">
            <thead className="text-left text-muted-foreground">
               <tr className="border-b">
                  <th className="px-6 py-2 font-normal">Received</th>
                  <th className="px-2 py-2 font-normal">Event</th>
                  <th className="px-2 py-2 font-normal">Status</th>
                  <th className="px-2 py-2 font-normal" />
               </tr>
            </thead>
            <tbody>
               {deliveries.map((delivery) => (
                  <Fragment key={delivery.id}>
                     <tr className="border-b">
                        <td className="px-6 py-2">
                           {new Date(delivery.receivedAt).toLocaleString()}
                           {delivery.replayOf && (
                              <span className="text-muted-foreground"> · replay</span>
                           )}
                        </td>
                        <td className="px-2 py-2">{delivery.event ?? '—'}</td>
                        <td className="px-2 py-2">
                           <Badge variant={statusVariant(delivery.status)}>{delivery.status}</Badge>{' '}
                           <span className="text-muted-foreground">
                              {delivery.failureReason ?? ''}
                           </span>
                        </td>
                        <td className="px-2 py-2 text-right">
                           <Button
                              type="button"
                              variant="ghost"
                              onClick={() => void togglePayload(delivery.id)}
                           >
                              {openId === delivery.id ? 'hide payload' : 'payload'}
                           </Button>{' '}
                           {delivery.status !== 'rejected' && (
                              <Button
                                 type="button"
                                 variant="outline"
                                 onClick={() => void replay(delivery.id)}
                              >
                                 replay
                              </Button>
                           )}
                        </td>
                     </tr>
                     {openId === delivery.id && (
                        <tr className="border-b">
                           <td colSpan={4} className="px-6 py-2">
                              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border p-3 text-muted-foreground">
                                 {payload}
                              </pre>
                           </td>
                        </tr>
                     )}
                  </Fragment>
               ))}
            </tbody>
         </table>
      </div>
   );
}
