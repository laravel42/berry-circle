'use client';

import { Copy, Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { absoluteApiUrl } from '@/lib/api';
import {
   addCronTrigger,
   addWebhookTrigger,
   deleteTrigger,
   describeAutopilotFailure,
   rotateWebhook,
   updateTrigger,
   type AutopilotDetail,
   type AutopilotTrigger,
   type WebhookSecrets,
} from '@/lib/autopilots';
import { localTimezone } from '@/lib/cron-schedule';

import ScheduleEditor from './schedule-editor';

interface Props {
   autopilot: AutopilotDetail;
   canEdit: boolean;
   onChanged: () => void;
}

export function copyToClipboard(value: string, done: string): void {
   void navigator.clipboard.writeText(value).then(
      () => toast.success(done),
      () => toast.error(done)
   );
}

/**
 * Shown once, straight after a webhook is made or rotated.
 *
 * The server keeps only a hash of the token and a sealed secret, so this is the
 * single moment either can be read. Everything here can be revealed and copied
 * deliberately; nothing is shown by accident.
 */
export function SecretsNotice({
   secrets,
   onDismiss,
}: {
   secrets: WebhookSecrets;
   onDismiss: () => void;
}) {
   const t = useTranslations('areas.autopilots.triggers');
   const [shown, setShown] = useState(false);
   const endpoint = absoluteApiUrl(secrets.ingressPath);
   const mask = (value: string) => (shown ? value : '•'.repeat(Math.min(32, value.length)));

   return (
      <div className="rounded-md border border-dashed p-4" role="status">
         <p className="font-medium">{t('secretsTitle')}</p>
         <p className="text-muted-foreground">{t('secretsBody')}</p>
         <div className="mt-3 grid gap-2">
            <Label>{t('endpoint')}</Label>
            <div className="flex gap-2">
               <Input readOnly value={mask(endpoint)} className="font-mono" />
               <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={shown ? t('hide') : t('show')}
                  onClick={() => setShown(!shown)}
               >
                  {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
               </Button>
               <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={t('copy')}
                  onClick={() => copyToClipboard(endpoint, t('copied'))}
               >
                  <Copy className="size-4" />
               </Button>
            </div>
            <Label>{t('signingSecret')}</Label>
            <div className="flex gap-2">
               <Input readOnly value={mask(secrets.signingSecret)} className="font-mono" />
               <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={t('copy')}
                  onClick={() => copyToClipboard(secrets.signingSecret, t('copied'))}
               >
                  <Copy className="size-4" />
               </Button>
            </div>
            <p className="text-muted-foreground">{t('signingHint')}</p>
         </div>
         <Button type="button" className="mt-3" size="xs" variant="ghost" onClick={onDismiss}>
            {t('dismiss')}
         </Button>
      </div>
   );
}

function TriggerRow({
   autopilotId,
   trigger,
   canEdit,
   onChanged,
   onSecrets,
}: {
   autopilotId: string;
   trigger: AutopilotTrigger;
   canEdit: boolean;
   onChanged: () => void;
   onSecrets: (secrets: WebhookSecrets) => void;
}) {
   const t = useTranslations('areas.autopilots.triggers');
   const [rotating, setRotating] = useState(false);

   const act = async (work: () => Promise<unknown>) => {
      try {
         await work();
         onChanged();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   };

   return (
      <div className="flex flex-wrap items-center gap-3 border-b py-3">
         <Switch
            checked={trigger.enabled}
            disabled={!canEdit}
            onCheckedChange={(enabled) =>
               void act(() => updateTrigger(autopilotId, trigger.id, { enabled }))
            }
            aria-label={t('enabled')}
         />
         <div className="min-w-0 flex-1">
            {trigger.kind === 'cron' ? (
               <>
                  <div className="font-medium">
                     <code>{trigger.cronExpression}</code> · {trigger.timezone}
                  </div>
                  <div className="text-muted-foreground">
                     {trigger.nextFireAt
                        ? t('next', { when: new Date(trigger.nextFireAt).toLocaleString() })
                        : t('notScheduled')}
                  </div>
               </>
            ) : (
               <>
                  <div className="font-medium">
                     {t('webhookName', { hint: trigger.tokenHint ?? '' })}
                  </div>
                  <div className="text-muted-foreground">
                     {trigger.eventFilters.length > 0
                        ? trigger.eventFilters.join(', ')
                        : t('everyEvent')}
                  </div>
                  <div className="text-muted-foreground">{t('urlHiddenHint')}</div>
               </>
            )}
         </div>
         {canEdit && trigger.kind === 'webhook' ? (
            <Button type="button" size="xs" variant="outline" onClick={() => setRotating(true)}>
               {t('rotate')}
            </Button>
         ) : null}
         {canEdit ? (
            <Button
               type="button"
               size="xs"
               variant="ghost"
               onClick={() => void act(() => deleteTrigger(autopilotId, trigger.id))}
            >
               {t('remove')}
            </Button>
         ) : null}

         <AlertDialog open={rotating} onOpenChange={setRotating}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>{t('rotateTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('rotateBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                     onClick={() =>
                        void act(async () => {
                           const { secrets } = await rotateWebhook(autopilotId, trigger.id);
                           onSecrets(secrets);
                           toast.success(t('rotated'));
                        })
                     }
                  >
                     {t('rotate')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}

/** What makes this autopilot run, and what it would take to change that. */
export default function TriggersTab({ autopilot, canEdit, onChanged }: Props) {
   const t = useTranslations('areas.autopilots.triggers');
   const [secrets, setSecrets] = useState<WebhookSecrets | null>(null);
   const [adding, setAdding] = useState<'cron' | 'webhook' | null>(null);
   const [schedule, setSchedule] = useState({
      expression: '0 9 * * 1-5',
      timezone: localTimezone(),
   });
   const [filters, setFilters] = useState('');
   const [busy, setBusy] = useState(false);

   const addSchedule = async () => {
      setBusy(true);
      try {
         await addCronTrigger(autopilot.id, schedule);
         setAdding(null);
         onChanged();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      } finally {
         setBusy(false);
      }
   };

   const addWebhook = async () => {
      setBusy(true);
      try {
         const made = await addWebhookTrigger(
            autopilot.id,
            filters
               .split(',')
               .map((name) => name.trim())
               .filter((name) => name !== '')
         );
         setFilters('');
         setAdding(null);
         setSecrets(made.secrets);
         onChanged();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      } finally {
         setBusy(false);
      }
   };

   return (
      <div className="grid gap-4 px-6 py-4">
         {secrets ? <SecretsNotice secrets={secrets} onDismiss={() => setSecrets(null)} /> : null}

         <div>
            {autopilot.triggers.length === 0 ? (
               <p className="text-muted-foreground">{t('none')}</p>
            ) : (
               autopilot.triggers.map((trigger) => (
                  <TriggerRow
                     key={trigger.id}
                     autopilotId={autopilot.id}
                     trigger={trigger}
                     canEdit={canEdit}
                     onChanged={onChanged}
                     onSecrets={(next) => {
                        setSecrets(next);
                        onChanged();
                     }}
                  />
               ))
            )}
         </div>

         {canEdit ? (
            adding === null ? (
               <div className="flex flex-wrap gap-2">
                  <Button
                     type="button"
                     size="xs"
                     variant="secondary"
                     onClick={() => setAdding('cron')}
                  >
                     {t('addSchedule')}
                  </Button>
                  <Button
                     type="button"
                     size="xs"
                     variant="secondary"
                     onClick={() => setAdding('webhook')}
                  >
                     {t('addWebhook')}
                  </Button>
               </div>
            ) : adding === 'cron' ? (
               <div className="grid max-w-2xl gap-3 rounded-md border p-4">
                  <ScheduleEditor
                     expression={schedule.expression}
                     timezone={schedule.timezone}
                     onChange={setSchedule}
                  />
                  <div className="flex gap-2">
                     <Button
                        type="button"
                        size="xs"
                        disabled={busy}
                        onClick={() => void addSchedule()}
                     >
                        {t('addSchedule')}
                     </Button>
                     <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => setAdding(null)}
                     >
                        {t('cancel')}
                     </Button>
                  </div>
               </div>
            ) : (
               <div className="grid max-w-2xl gap-2 rounded-md border p-4">
                  <Label htmlFor="webhook-filters">{t('filters')}</Label>
                  <Input
                     id="webhook-filters"
                     value={filters}
                     onChange={(event) => setFilters(event.target.value)}
                  />
                  <p className="text-muted-foreground">{t('filtersHint')}</p>
                  <div className="flex gap-2">
                     <Button
                        type="button"
                        size="xs"
                        disabled={busy}
                        onClick={() => void addWebhook()}
                     >
                        {t('addWebhook')}
                     </Button>
                     <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => setAdding(null)}
                     >
                        {t('cancel')}
                     </Button>
                  </div>
               </div>
            )
         ) : null}
      </div>
   );
}
