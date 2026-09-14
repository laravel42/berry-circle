'use client';

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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
   SettingsCard,
   SettingsRow,
   SettingsSection,
   SettingsShell,
} from '@/components/common/settings/shared';
import { useSettingsResource } from '@/components/common/settings/use-settings-resource';
import { RuntimeUsagePanel } from '@/components/common/usage/runtime-usage-panel';
import {
   checkRuntimeHealth,
   createProfile,
   deleteRuntime,
   formatSeconds,
   getRuntime,
   listProfiles,
   updateRuntime,
   type RuntimeDetail as Detail,
   type RuntimeProfile,
} from '@/lib/runtimes';
import { RUNTIME_DAY_OPTIONS, type UsageQuery } from '@/lib/usage';
import { localTimezone } from '@/lib/cron-schedule';
import { useSessionStore } from '@/store/session-store';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

/** One runtime: its health, its session lifecycle, recent activity and profiles. */
export default function RuntimeDetail({ runtimeId }: { runtimeId: string }) {
   const t = useTranslations('areas.runtimes');
   const tUsage = useTranslations('areas.usage.filters');
   const router = useRouter();
   const { orgId } = useParams<{ orgId: string }>();
   const viewerId = useSessionStore((state) => state.user?.id ?? null);
   const runtime = useSettingsResource<Detail>(() => getRuntime(runtimeId), [runtimeId]);
   const profiles = useSettingsResource<RuntimeProfile[]>(
      () => listProfiles(runtimeId),
      [runtimeId]
   );
   const [checking, setChecking] = useState(false);
   const [profileName, setProfileName] = useState('');
   const [idleHours, setIdleHours] = useState('1');
   const [usageQuery, setUsageQuery] = useState<UsageQuery>({
      days: 30,
      timezone: localTimezone(),
   });
   const [confirmingDelete, setConfirmingDelete] = useState(false);
   const [acknowledged, setAcknowledged] = useState(false);
   const [deleting, setDeleting] = useState(false);

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

   async function setVisibility(visibility: 'private' | 'workspace') {
      try {
         await updateRuntime(runtimeId, { visibility });
         runtime.reload();
      } catch (error) {
         toast.error(error instanceof Error ? error.message : 'The runtime could not be updated.');
      }
   }

   async function remove() {
      setDeleting(true);
      try {
         await deleteRuntime(runtimeId);
         toast.success(t('deleted'));
         router.push(`/${orgId}/runtimes`);
      } catch (error) {
         toast.error(error instanceof Error ? error.message : t('deleteFailed'));
         setDeleting(false);
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
   // A private runtime is its registrant's to share; nobody else may change that.
   const ownsRuntime = value?.ownerId !== null && value?.ownerId === viewerId;
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
               <SettingsSection
                  title={t('usageTitle')}
                  description={t('usageDescription')}
                  action={
                     <div className="flex items-center gap-1 rounded-md border p-0.5">
                        {RUNTIME_DAY_OPTIONS.map((days) => (
                           <Button
                              key={days}
                              size="xxs"
                              variant={usageQuery.days === days ? 'secondary' : 'ghost'}
                              onClick={() => setUsageQuery({ ...usageQuery, days })}
                           >
                              {tUsage('days', { count: days })}
                           </Button>
                        ))}
                     </div>
                  }
               >
                  <SettingsCard className="p-4">
                     <RuntimeUsagePanel runtimeId={runtimeId} query={usageQuery} />
                  </SettingsCard>
               </SettingsSection>

               <SettingsSection title={t('servingAgents')}>
                  <SettingsCard>
                     {value.servingAgents.length === 0 ? (
                        <p className="p-4 text-muted-foreground">{t('servingEmpty')}</p>
                     ) : (
                        value.servingAgents.map((agent) => (
                           <SettingsRow
                              key={agent.id}
                              title={agent.name}
                              description={`${agent.status} · ${agent.profileName ?? t('noProfile')}`}
                              chevron
                              onClick={() => router.push(`/${orgId}/agents/${agent.id}`)}
                           />
                        ))
                     )}
                  </SettingsCard>
               </SettingsSection>

               {value.kind === 'custom' && (
                  <SettingsSection
                     title={t('visibility')}
                     description={ownsRuntime ? undefined : t('visibilityHint')}
                  >
                     <SettingsCard>
                        {(['private', 'workspace'] as const).map((option) => (
                           <SettingsRow
                              key={option}
                              title={t(option)}
                              description={t(`${option}Hint`)}
                              muted={!ownsRuntime}
                              trailing={
                                 <Button
                                    size="xs"
                                    variant={value.visibility === option ? 'secondary' : 'ghost'}
                                    disabled={!ownsRuntime || value.visibility === option}
                                    onClick={() => void setVisibility(option)}
                                 >
                                    {value.visibility === option ? '✓' : t(option)}
                                 </Button>
                              }
                           />
                        ))}
                     </SettingsCard>
                  </SettingsSection>
               )}

               {value.kind === 'custom' && (
                  <SettingsSection title={t('dangerZone')}>
                     <SettingsCard>
                        <SettingsRow
                           title={t('delete')}
                           description={t('deleteHint')}
                           trailing={
                              <Button
                                 size="sm"
                                 variant="destructive"
                                 onClick={() => {
                                    setAcknowledged(false);
                                    setConfirmingDelete(true);
                                 }}
                              >
                                 {t('delete')}
                              </Button>
                           }
                        />
                     </SettingsCard>
                  </SettingsSection>
               )}

               <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
                  <AlertDialogContent>
                     <AlertDialogHeader>
                        <AlertDialogTitle>
                           {t('confirmTitle', { name: value.name })}
                        </AlertDialogTitle>
                        <AlertDialogDescription>{t('confirmBody')}</AlertDialogDescription>
                     </AlertDialogHeader>
                     <div className="flex flex-col gap-3">
                        {value.servingAgents.length === 0 ? (
                           <p className="text-muted-foreground">{t('affectedNone')}</p>
                        ) : (
                           <div className="flex flex-col gap-1">
                              <p className="text-muted-foreground">
                                 {t('affected', { count: value.servingAgents.length })}
                              </p>
                              <ul className="max-h-40 overflow-auto rounded-md border p-2">
                                 {value.servingAgents.map((agent) => (
                                    <li key={agent.id}>{agent.name}</li>
                                 ))}
                              </ul>
                           </div>
                        )}
                        <label className="flex items-center gap-2">
                           <Checkbox
                              checked={acknowledged}
                              onCheckedChange={(checked) => setAcknowledged(checked === true)}
                           />
                           {t('confirmAck')}
                        </label>
                     </div>
                     <AlertDialogFooter>
                        <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                        <AlertDialogAction
                           disabled={!acknowledged || deleting}
                           onClick={(event) => {
                              event.preventDefault();
                              void remove();
                           }}
                        >
                           {t('delete')}
                        </AlertDialogAction>
                     </AlertDialogFooter>
                  </AlertDialogContent>
               </AlertDialog>
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
