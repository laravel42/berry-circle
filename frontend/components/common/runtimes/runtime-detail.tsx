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
import {
   checkRuntimeHealth,
   createProfile,
   formatSeconds,
   getRuntime,
   listProfiles,
   updateRuntime,
   type RuntimeDetail as Detail,
   type RuntimeProfile,
} from '@/lib/runtimes';
import { useState } from 'react';
import { toast } from 'sonner';

/** One runtime: its health, its session lifecycle, recent activity and profiles. */
export default function RuntimeDetail({ runtimeId }: { runtimeId: string }) {
   const runtime = useSettingsResource<Detail>(() => getRuntime(runtimeId), [runtimeId]);
   const profiles = useSettingsResource<RuntimeProfile[]>(
      () => listProfiles(runtimeId),
      [runtimeId]
   );
   const [checking, setChecking] = useState(false);
   const [profileName, setProfileName] = useState('');
   const [idleHours, setIdleHours] = useState('1');

   async function probe() {
      setChecking(true);
      try {
         await checkRuntimeHealth(runtimeId);
         runtime.reload();
      } catch (error) {
         toast.error(error instanceof Error ? error.message : 'The health check could not run.');
      } finally {
         setChecking(false);
      }
   }

   async function makeDefault() {
      try {
         await updateRuntime(runtimeId, { isDefault: true });
         runtime.reload();
      } catch (error) {
         toast.error(error instanceof Error ? error.message : 'The runtime could not be updated.');
      }
   }

   async function addProfile() {
      const hours = Number(idleHours);
      if (!Number.isFinite(hours) || hours * 3600 < 60 || hours > 8) {
         toast.error('The idle timeout must be between one minute and eight hours.');
         return;
      }
      try {
         const saved = await createProfile(runtimeId, {
            name: profileName.trim(),
            idleTimeoutS: Math.round(hours * 3600),
         });
         if (saved.lifecycleApplied === false) {
            toast.error(
               `The profile was saved, but the runtime was not updated: ${saved.lifecycleError ?? 'unknown error'}`
            );
         }
         setProfileName('');
         profiles.reload();
      } catch (error) {
         toast.error(error instanceof Error ? error.message : 'The profile could not be saved.');
      }
   }

   const value = runtime.value;
   const busiest = Math.max(1, ...(value?.activity ?? []).map((day) => day.runs));

   return (
      <SettingsShell
         title={value?.name ?? 'Runtime'}
         description={value?.arn ?? value?.endpointUrl ?? undefined}
      >
         {runtime.error && <p className="text-destructive">{runtime.error}</p>}
         {value && (
            <>
               <SettingsSection
                  title="Health"
                  action={
                     <Button
                        size="sm"
                        variant="outline"
                        disabled={checking}
                        onClick={() => void probe()}
                     >
                        Check now
                     </Button>
                  }
               >
                  <SettingsCard>
                     <SettingsRow
                        title={value.status}
                        description={
                           value.lastHealthAt
                              ? `Last checked ${new Date(value.lastHealthAt).toLocaleString()}${value.lastHealthError ? `: ${value.lastHealthError}` : ''}`
                              : 'Never checked'
                        }
                     />
                     <SettingsRow
                        title="Sessions"
                        description={`Idle sessions end after ${formatSeconds(value.idleTimeoutS)}. No session lives longer than ${formatSeconds(value.maxLifetimeS)}.`}
                     />
                     <SettingsRow
                        title="Concurrency"
                        description={`${value.activeRuns} queued or running${value.concurrencyLimit ? ` of ${value.concurrencyLimit}` : ''}`}
                        trailing={
                           value.isDefault ? undefined : (
                              <Button size="sm" variant="ghost" onClick={() => void makeDefault()}>
                                 Make default
                              </Button>
                           )
                        }
                     />
                  </SettingsCard>
               </SettingsSection>
               <SettingsSection
                  title="Activity"
                  description="Tasks started on this runtime in the last 30 days."
               >
                  <SettingsCard className="p-4">
                     {value.activity.length === 0 ? (
                        <p className="text-muted-foreground">No tasks in the last 30 days.</p>
                     ) : (
                        <div
                           className="flex h-24 items-end gap-1"
                           role="img"
                           aria-label="Tasks per day"
                        >
                           {value.activity.map((day) => (
                              <div
                                 key={day.day}
                                 title={`${day.day}: ${day.runs} tasks, ${day.failed} failed`}
                                 className="flex-1 rounded-sm bg-primary/70"
                                 style={{ height: `${(day.runs / busiest) * 100}%` }}
                              />
                           ))}
                        </div>
                     )}
                  </SettingsCard>
               </SettingsSection>
            </>
         )}
         <SettingsSection
            title="Profiles"
            description="Environment, default model and session idle timeout for agents bound to this runtime. Environment values are sealed and never shown again."
         >
            <SettingsCard>
               {profiles.value?.map((profile) => (
                  <SettingsRow
                     key={profile.id}
                     title={profile.name}
                     description={`${profile.envKeys.length} env vars${profile.idleTimeoutS ? ` · idle ${formatSeconds(profile.idleTimeoutS)}` : ''}${profile.modelDefault ? ` · ${profile.modelDefault}` : ''}`}
                  />
               ))}
               <div className="flex flex-wrap items-center gap-2 p-4">
                  <Input
                     className="max-w-48"
                     placeholder="Profile name"
                     aria-label="Profile name"
                     value={profileName}
                     onChange={(event) => setProfileName(event.target.value)}
                  />
                  <Input
                     className="max-w-28"
                     type="number"
                     min={0.1}
                     max={8}
                     step={0.5}
                     aria-label="Idle timeout in hours"
                     value={idleHours}
                     onChange={(event) => setIdleHours(event.target.value)}
                  />
                  <Button disabled={profileName.trim() === ''} onClick={() => void addProfile()}>
                     Add profile
                  </Button>
               </div>
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
