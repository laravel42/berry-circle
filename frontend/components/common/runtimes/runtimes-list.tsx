'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   SettingsCard,
   SettingsRow,
   SettingsSection,
   SettingsShell,
} from '@/components/common/settings/shared';
import { useSettingsResource } from '@/components/common/settings/use-settings-resource';
import { createRuntime, formatSeconds, listRuntimes, type Runtime } from '@/lib/runtimes';
import { Server } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * Where this workspace's agents run. The platform runtime is the deployment's
 * own; an owner can register another AgentCore Runtime by ARN and bind agents
 * to it. Health is a real probe, run from the detail page.
 */
export default function RuntimesList() {
   const runtimes = useSettingsResource<Runtime[]>(listRuntimes);
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   const [name, setName] = useState('');
   const [arn, setArn] = useState('');
   const [adding, setAdding] = useState(false);

   async function add() {
      setAdding(true);
      try {
         await createRuntime({ name: name.trim(), driver: 'agentcore', arn: arn.trim() });
         setName('');
         setArn('');
         runtimes.reload();
      } catch (error) {
         toast.error(error instanceof Error ? error.message : 'The runtime could not be added.');
      } finally {
         setAdding(false);
      }
   }

   return (
      <SettingsShell
         title="Runtimes"
         description="Where agents run. A follow-up run on an issue picks up the same session while it is still warm."
      >
         <SettingsSection title="Registered runtimes">
            <SettingsCard>
               {runtimes.error && <p className="p-4 text-destructive">{runtimes.error}</p>}
               {runtimes.loading && !runtimes.value && (
                  <p className="p-4 text-muted-foreground">Loading…</p>
               )}
               {runtimes.value?.length === 0 && (
                  <p className="p-4 text-muted-foreground">
                     This deployment has no runtime configured yet.
                  </p>
               )}
               {runtimes.value?.map((runtime) => (
                  <SettingsRow
                     key={runtime.id}
                     icon={<Server className="size-4" />}
                     title={
                        <span className="flex items-center gap-2">
                           {runtime.name}
                           {runtime.isDefault && (
                              <span className="text-muted-foreground">default</span>
                           )}
                        </span>
                     }
                     description={`${runtime.status} · ${runtime.activeRuns} active · idle ${formatSeconds(runtime.idleTimeoutS)} · life ${formatSeconds(runtime.maxLifetimeS)}`}
                     chevron
                     onClick={() => router.push(`/${orgId}/runtimes/${runtime.id}`)}
                  />
               ))}
            </SettingsCard>
         </SettingsSection>
         <SettingsSection
            title="Register an AgentCore Runtime"
            description="The runtime must run Berry's agent image. The AgentCore console shows its ARN."
         >
            <SettingsCard className="flex flex-col gap-3 p-4">
               <Input
                  placeholder="Name"
                  aria-label="Runtime name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
               />
               <Input
                  placeholder="arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/…"
                  aria-label="Runtime ARN"
                  value={arn}
                  onChange={(event) => setArn(event.target.value)}
               />
               <div>
                  <Button
                     disabled={adding || name.trim() === '' || arn.trim() === ''}
                     onClick={() => void add()}
                  >
                     Register runtime
                  </Button>
               </div>
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
