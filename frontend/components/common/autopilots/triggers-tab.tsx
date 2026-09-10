'use client';

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
   previewCron,
   rotateWebhook,
   updateTrigger,
   type AutopilotDetail,
   type AutopilotTrigger,
   type WebhookSecrets,
} from '@/lib/autopilots';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Props {
   autopilot: AutopilotDetail;
   onChanged: () => void;
}

function localZone(): string {
   return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Shown once, straight after a webhook is made or rotated. The server keeps
 * only a hash of the token and a sealed secret, so closing this is final.
 */
function SecretsNotice({ secrets, onDismiss }: { secrets: WebhookSecrets; onDismiss: () => void }) {
   const endpoint = absoluteApiUrl(secrets.ingressPath);
   const copy = (value: string) => {
      void navigator.clipboard.writeText(value).then(() => toast.success('Copied'));
   };
   return (
      <div className="rounded-md border border-dashed p-4" role="status">
         <p className="font-medium">Copy these now — Berry will not show them again.</p>
         <div className="mt-3 grid gap-2">
            <Label>Endpoint (POST)</Label>
            <div className="flex gap-2">
               <Input readOnly value={endpoint} />
               <Button type="button" variant="outline" onClick={() => copy(endpoint)}>
                  copy
               </Button>
            </div>
            <Label>Signing secret</Label>
            <div className="flex gap-2">
               <Input readOnly value={secrets.signingSecret} />
               <Button type="button" variant="outline" onClick={() => copy(secrets.signingSecret)}>
                  copy
               </Button>
            </div>
            <p className="text-muted-foreground">
               Sign the raw body with HMAC-SHA256 and send it as{' '}
               <code>X-Berry-Signature: sha256=&lt;hex&gt;</code>. Name the event in{' '}
               <code>X-Berry-Event</code> or a top-level <code>event</code> field.
            </p>
         </div>
         <Button type="button" className="mt-3" variant="ghost" onClick={onDismiss}>
            I have copied them
         </Button>
      </div>
   );
}

function CronForm({ autopilotId, onAdded }: { autopilotId: string; onAdded: () => void }) {
   const [expression, setExpression] = useState('0 9 * * 1-5');
   const [timezone, setTimezone] = useState(localZone);
   const [preview, setPreview] = useState<string[]>([]);
   const [problem, setProblem] = useState<string | null>(null);

   useEffect(() => {
      const timer = setTimeout(() => {
         void previewCron(expression, timezone, 5)
            .then((times) => {
               setPreview(times);
               setProblem(null);
            })
            .catch((failure: unknown) => {
               setPreview([]);
               setProblem(describeAutopilotFailure(failure));
            });
      }, 300);
      return () => clearTimeout(timer);
   }, [expression, timezone]);

   async function add() {
      try {
         await addCronTrigger(autopilotId, { expression, timezone });
         onAdded();
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   }

   return (
      <div className="grid gap-2 rounded-md border p-4">
         <p className="font-medium">Schedule</p>
         <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="grid gap-1">
               <Label htmlFor="cron-expression">Cron (minute hour day month weekday)</Label>
               <Input
                  id="cron-expression"
                  value={expression}
                  onChange={(e) => setExpression(e.target.value)}
               />
            </div>
            <div className="grid gap-1">
               <Label htmlFor="cron-zone">Time zone</Label>
               <Input
                  id="cron-zone"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
               />
            </div>
         </div>
         {problem ? (
            <p className="text-destructive" role="alert">
               {problem}
            </p>
         ) : (
            <ul className="text-muted-foreground">
               {preview.map((time) => (
                  <li key={time}>{new Date(time).toLocaleString()}</li>
               ))}
            </ul>
         )}
         <div>
            <Button type="button" disabled={problem !== null} onClick={() => void add()}>
               add schedule
            </Button>
         </div>
      </div>
   );
}

function WebhookForm({
   autopilotId,
   onAdded,
}: {
   autopilotId: string;
   onAdded: (secrets: WebhookSecrets) => void;
}) {
   const [filters, setFilters] = useState('');

   async function add() {
      const eventFilters = filters
         .split(',')
         .map((name) => name.trim())
         .filter((name) => name !== '');
      try {
         const { secrets } = await addWebhookTrigger(autopilotId, eventFilters);
         setFilters('');
         onAdded(secrets);
      } catch (failure) {
         toast.error(describeAutopilotFailure(failure));
      }
   }

   return (
      <div className="grid gap-2 rounded-md border p-4">
         <p className="font-medium">Webhook</p>
         <Label htmlFor="webhook-filters">Only these events (comma separated, empty for all)</Label>
         <Input id="webhook-filters" value={filters} onChange={(e) => setFilters(e.target.value)} />
         <div>
            <Button type="button" onClick={() => void add()}>
               add webhook
            </Button>
         </div>
      </div>
   );
}

function TriggerRow({
   autopilotId,
   trigger,
   onChanged,
   onSecrets,
}: {
   autopilotId: string;
   trigger: AutopilotTrigger;
   onChanged: () => void;
   onSecrets: (secrets: WebhookSecrets) => void;
}) {
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
            onCheckedChange={(enabled) =>
               void act(() => updateTrigger(autopilotId, trigger.id, { enabled }))
            }
            aria-label="Enabled"
         />
         <div className="min-w-0 flex-1">
            {trigger.kind === 'cron' ? (
               <>
                  <div className="font-medium">
                     <code>{trigger.cronExpression}</code> · {trigger.timezone}
                  </div>
                  <div className="text-muted-foreground">
                     {trigger.nextFireAt
                        ? `next ${new Date(trigger.nextFireAt).toLocaleString()}`
                        : 'not scheduled'}
                  </div>
               </>
            ) : (
               <>
                  <div className="font-medium">Webhook ····{trigger.tokenHint}</div>
                  <div className="text-muted-foreground">
                     {trigger.eventFilters.length > 0
                        ? trigger.eventFilters.join(', ')
                        : 'every event'}
                  </div>
               </>
            )}
         </div>
         {trigger.kind === 'webhook' && (
            <Button
               type="button"
               variant="outline"
               onClick={() =>
                  void act(async () => {
                     const { secrets } = await rotateWebhook(autopilotId, trigger.id);
                     onSecrets(secrets);
                  })
               }
            >
               rotate
            </Button>
         )}
         <Button
            type="button"
            variant="ghost"
            onClick={() => void act(() => deleteTrigger(autopilotId, trigger.id))}
         >
            remove
         </Button>
      </div>
   );
}

export default function TriggersTab({ autopilot, onChanged }: Props) {
   const [secrets, setSecrets] = useState<WebhookSecrets | null>(null);
   return (
      <div className="grid gap-4 px-6 py-4">
         {secrets && <SecretsNotice secrets={secrets} onDismiss={() => setSecrets(null)} />}
         <div>
            {autopilot.triggers.length === 0 ? (
               <p className="text-muted-foreground">
                  No triggers yet. It runs only when someone presses run now.
               </p>
            ) : (
               autopilot.triggers.map((trigger) => (
                  <TriggerRow
                     key={trigger.id}
                     autopilotId={autopilot.id}
                     trigger={trigger}
                     onChanged={onChanged}
                     onSecrets={(next) => {
                        setSecrets(next);
                        onChanged();
                     }}
                  />
               ))
            )}
         </div>
         <div className="grid gap-4 md:grid-cols-2">
            <CronForm autopilotId={autopilot.id} onAdded={onChanged} />
            <WebhookForm
               autopilotId={autopilot.id}
               onAdded={(next) => {
                  setSecrets(next);
                  onChanged();
               }}
            />
         </div>
      </div>
   );
}
