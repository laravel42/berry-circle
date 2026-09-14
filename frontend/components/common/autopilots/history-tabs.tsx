'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
   describeAutopilotFailure,
   describeReason,
   getWebhookDelivery,
   replayDelivery,
   type AutopilotRun,
   type WebhookDelivery,
} from '@/lib/autopilots';

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
   if (status === 'enqueued' || status === 'accepted') return 'default';
   if (status === 'failed' || status === 'rejected') return 'destructive';
   if (status === 'skipped' || status === 'filtered') return 'secondary';
   return 'outline';
}

/** A run of its own, or a run of skipped ones folded together. */
type Entry = { kind: 'run'; run: AutopilotRun } | { kind: 'skipped'; runs: AutopilotRun[] };

/**
 * Consecutive skipped firings become one row.
 *
 * A paused autopilot on a five-minute schedule writes hundreds of identical
 * "skipped" rows, and they bury the runs that actually did something.
 */
export function foldSkipped(runs: AutopilotRun[]): Entry[] {
   const entries: Entry[] = [];
   for (const run of runs) {
      const last = entries.at(-1);
      if (run.status === 'skipped') {
         if (last?.kind === 'skipped' && last.runs[0]?.reasonCode === run.reasonCode) {
            last.runs.push(run);
         } else {
            entries.push({ kind: 'skipped', runs: [run] });
         }
      } else {
         entries.push({ kind: 'run', run });
      }
   }
   return entries;
}

export function RunsTable({ runs, orgId }: { runs: AutopilotRun[]; orgId: string }) {
   const t = useTranslations('areas.autopilots.history');
   const [expanded, setExpanded] = useState<string[]>([]);

   if (runs.length === 0) {
      return <p className="px-6 py-6 text-muted-foreground">{t('noRuns')}</p>;
   }
   const entries = foldSkipped(runs);

   const row = (run: AutopilotRun) => (
      <tr key={run.id} className="border-b">
         <td className="px-6 py-2">{new Date(run.createdAt).toLocaleString()}</td>
         <td className="px-2 py-2">{run.source}</td>
         <td className="px-2 py-2">
            <Badge variant={statusVariant(run.status)}>{run.status}</Badge>{' '}
            <span className="text-muted-foreground" title={run.reasonMessage ?? undefined}>
               {describeReason(run.reasonCode)}
               {run.taskStatus ? ` · ${run.taskStatus}` : ''}
            </span>
         </td>
         <td className="px-2 py-2">
            {run.issueId ? (
               <Link className="underline" href={`/${orgId}/issue/${run.issueId}`}>
                  {t('openTask')}
               </Link>
            ) : (
               <span className="text-muted-foreground">—</span>
            )}
         </td>
         <td className="px-2 py-2">
            {run.runId ? (
               <Link className="underline" href={`/${orgId}/runs?run=${run.runId}`}>
                  {t('transcript')}
               </Link>
            ) : (
               <span className="text-muted-foreground">—</span>
            )}
         </td>
         <td className="px-2 py-2 text-muted-foreground">v{run.autopilotVersion}</td>
      </tr>
   );

   return (
      <div className="overflow-x-auto">
         <table className="w-full">
            <thead className="text-left text-muted-foreground">
               <tr className="border-b">
                  <th className="px-6 py-2 font-normal">{t('when')}</th>
                  <th className="px-2 py-2 font-normal">{t('source')}</th>
                  <th className="px-2 py-2 font-normal">{t('outcome')}</th>
                  <th className="px-2 py-2 font-normal">{t('task')}</th>
                  <th className="px-2 py-2 font-normal">{t('transcript')}</th>
                  <th className="px-2 py-2 font-normal">{t('version')}</th>
               </tr>
            </thead>
            <tbody>
               {entries.map((entry) => {
                  if (entry.kind === 'run') return row(entry.run);
                  const first = entry.runs[0];
                  if (!first) return null;
                  if (entry.runs.length === 1) return row(first);
                  const open = expanded.includes(first.id);
                  return (
                     <Fragment key={first.id}>
                        <tr className="border-b">
                           <td className="px-6 py-2" colSpan={6}>
                              <Button
                                 type="button"
                                 size="xs"
                                 variant="ghost"
                                 onClick={() =>
                                    setExpanded((current) =>
                                       open
                                          ? current.filter((id) => id !== first.id)
                                          : [...current, first.id]
                                    )
                                 }
                              >
                                 {t('skippedGroup', {
                                    count: entry.runs.length,
                                    reason: describeReason(first.reasonCode) || t('skippedOne'),
                                 })}
                              </Button>
                           </td>
                        </tr>
                        {open ? entry.runs.map(row) : null}
                     </Fragment>
                  );
               })}
            </tbody>
         </table>
      </div>
   );
}

/**
 * Whether this delivery can be fired again, and why not when it cannot.
 *
 * A rejected delivery was refused at the door — most often a signature that did
 * not check out — and the server refuses to replay it. Saying so here means the
 * button explains itself instead of failing.
 */
export function replayBlock(delivery: WebhookDelivery): 'signature' | 'rejected' | 'queued' | null {
   if (delivery.status === 'rejected') {
      return (delivery.failureReason ?? '').toLowerCase().includes('signature')
         ? 'signature'
         : 'rejected';
   }
   if (delivery.autopilotRunId === null && delivery.status === 'accepted') return 'queued';
   return null;
}

/** Whether the signature checked out, as far as the delivery's record says. */
export function signatureState(delivery: WebhookDelivery): 'ok' | 'bad' {
   const reason = (delivery.failureReason ?? '').toLowerCase();
   return delivery.status === 'rejected' && reason.includes('signature') ? 'bad' : 'ok';
}

export function DeliveriesTable({
   autopilotId,
   deliveries,
   canReplay,
   onReplayed,
}: {
   autopilotId: string;
   deliveries: WebhookDelivery[];
   canReplay: boolean;
   onReplayed: () => void;
}) {
   const t = useTranslations('areas.autopilots.history');
   const [open, setOpen] = useState<{ delivery: WebhookDelivery; payload: string } | null>(null);

   /** How many times this delivery has been through Berry, replays included. */
   const attempts = (delivery: WebhookDelivery) =>
      1 + deliveries.filter((entry) => entry.replayOf === delivery.id).length;

   async function showPayload(delivery: WebhookDelivery) {
      try {
         const detail = await getWebhookDelivery(autopilotId, delivery.id);
         setOpen({
            delivery,
            payload:
               detail.payload === null || detail.payload === undefined
                  ? t('noPayload')
                  : JSON.stringify(detail.payload, null, 2),
         });
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   }

   async function replay(delivery: WebhookDelivery) {
      try {
         const outcome = await replayDelivery(autopilotId, delivery.id);
         toast.success(t('replayed', { status: outcome.status }));
         onReplayed();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   }

   if (deliveries.length === 0) {
      return <p className="px-6 py-6 text-muted-foreground">{t('noDeliveries')}</p>;
   }

   return (
      <div className="overflow-x-auto">
         <table className="w-full">
            <thead className="text-left text-muted-foreground">
               <tr className="border-b">
                  <th className="px-6 py-2 font-normal">{t('received')}</th>
                  <th className="px-2 py-2 font-normal">{t('event')}</th>
                  <th className="px-2 py-2 font-normal">{t('status')}</th>
                  <th className="px-2 py-2 font-normal">{t('signature')}</th>
                  <th className="px-2 py-2 font-normal">{t('attempts')}</th>
                  <th className="px-2 py-2 font-normal" />
               </tr>
            </thead>
            <tbody>
               {deliveries.map((delivery) => {
                  const blocked = replayBlock(delivery);
                  const signature = signatureState(delivery);
                  return (
                     <tr key={delivery.id} className="border-b">
                        <td className="px-6 py-2">
                           {new Date(delivery.receivedAt).toLocaleString()}
                           {delivery.replayOf ? (
                              <span className="text-muted-foreground"> · {t('isReplay')}</span>
                           ) : null}
                        </td>
                        <td className="px-2 py-2">{delivery.event ?? '—'}</td>
                        <td className="px-2 py-2">
                           <Badge variant={statusVariant(delivery.status)}>{delivery.status}</Badge>{' '}
                           <span className="text-muted-foreground">
                              {delivery.failureReason ?? ''}
                           </span>
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">
                           {signature === 'ok' ? t('signatureOk') : t('signatureBad')}
                        </td>
                        <td className="px-2 py-2 tabular-nums text-muted-foreground">
                           {attempts(delivery)}
                        </td>
                        <td className="px-2 py-2 text-right">
                           <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              onClick={() => void showPayload(delivery)}
                           >
                              {t('payload')}
                           </Button>{' '}
                           {canReplay ? (
                              <Button
                                 type="button"
                                 size="xs"
                                 variant="outline"
                                 disabled={blocked !== null}
                                 title={blocked ? t(`replayBlocked_${blocked}`) : undefined}
                                 onClick={() => void replay(delivery)}
                              >
                                 {t('replay')}
                              </Button>
                           ) : null}
                        </td>
                     </tr>
                  );
               })}
            </tbody>
         </table>

         <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
            <DialogContent className="sm:max-w-2xl">
               <DialogHeader>
                  <DialogTitle>
                     {t('payloadTitle', { event: open?.delivery.event ?? '—' })}
                  </DialogTitle>
               </DialogHeader>
               <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border p-3 font-mono">
                  {open?.payload}
               </pre>
            </DialogContent>
         </Dialog>
      </div>
   );
}
