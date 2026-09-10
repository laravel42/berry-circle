'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
   deletePluginSecret,
   loadPlugin,
   loadPluginInvocations,
   loadPluginStorage,
   setPluginSecret,
   setPluginTool,
   uninstallPlugin,
   updatePlugin,
   type PluginConfigValue,
   type PluginInstallation,
   type PluginInvocation,
   type PluginStoredValue,
} from '@/lib/plugins';
import { useSessionStore } from '@/store/session-store';
import { ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PluginConfigForm } from './plugin-config-form';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

type Detail = PluginInstallation & { files: { path: string; size: number }[] };

/** One installed plugin: everything an admin can change about it, and what it has been doing. */
export default function PluginDetail() {
   const router = useRouter();
   const { orgId, pluginId } = useParams<{ orgId: string; pluginId: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const need = <T,>(work: () => Promise<T>) =>
      workspaceId ? work() : Promise.reject(new Error('No workspace is selected.'));

   const plugin = useSettingsResource<Detail>(
      () => need(() => loadPlugin(workspaceId, pluginId)),
      [workspaceId, pluginId]
   );
   const invocations = useSettingsResource<PluginInvocation[]>(
      () => need(() => loadPluginInvocations(workspaceId, pluginId)),
      [workspaceId, pluginId]
   );
   const storage = useSettingsResource<PluginStoredValue[]>(
      () => need(() => loadPluginStorage(workspaceId, pluginId)),
      [workspaceId, pluginId]
   );

   const [config, setConfig] = useState<Record<string, PluginConfigValue>>({});
   const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
   useEffect(() => {
      if (plugin.value) setConfig(plugin.value.config);
   }, [plugin.value]);

   const current = plugin.value;
   if (!current) {
      return (
         <SettingsShell title="Plugin" description={plugin.error ?? 'Loading…'}>
            {null}
         </SettingsShell>
      );
   }

   const keep = (next: PluginInstallation): Detail => ({ ...next, files: current.files });

   const toggle = (enabled: boolean) =>
      plugin.mutate({ ...current, enabled }, async () =>
         keep(await updatePlugin(workspaceId, pluginId, { enabled }))
      );

   const saveConfig = () =>
      plugin.mutate({ ...current, config }, async () =>
         keep(await updatePlugin(workspaceId, pluginId, { config }))
      );

   const saveSecret = async (name: string) => {
      const value = secretDrafts[name]?.trim() ?? '';
      if (value === '') return;
      const secrets = current.secrets.map((s) => (s.name === name ? { ...s, set: true } : s));
      const ok = await plugin.mutate({ ...current, secrets }, () =>
         setPluginSecret(workspaceId, pluginId, name, value)
      );
      if (ok) setSecretDrafts((drafts) => ({ ...drafts, [name]: '' }));
   };

   const clearSecret = (name: string) => {
      const secrets = current.secrets.map((s) => (s.name === name ? { ...s, set: false } : s));
      return plugin.mutate({ ...current, secrets }, () =>
         deletePluginSecret(workspaceId, pluginId, name)
      );
   };

   const approve = (tool: string, approved: boolean) => {
      const mcpTools = current.mcpTools.map((t) => (t.name === tool ? { ...t, approved } : t));
      return plugin.mutate({ ...current, mcpTools }, async () =>
         keep(await setPluginTool(workspaceId, pluginId, tool, approved))
      );
   };

   const uninstall = async () => {
      if (
         !window.confirm(
            `Uninstall ${current.name}? Its settings, secrets and storage are deleted.`
         )
      )
         return;
      try {
         await uninstallPlugin(workspaceId, pluginId);
         router.push(`/${orgId}/settings/plugins`);
      } catch (cause) {
         toast.error(
            cause instanceof Error ? cause.message : 'The plugin could not be uninstalled.'
         );
      }
   };

   return (
      <SettingsShell
         title={current.name}
         description={`${current.key} · v${current.version}${current.description ? ` · ${current.description}` : ''}`}
      >
         <SettingsSection title="Status">
            <SettingsCard>
               <SettingsRow
                  title="Enabled"
                  description="A disabled plugin receives no calls and its tokens stop working."
                  trailing={
                     <Switch
                        checked={current.enabled}
                        disabled={plugin.saving}
                        onCheckedChange={(v) => void toggle(v)}
                     />
                  }
               />
               <SettingsRow title="Access" description={current.scopes.join(', ') || 'None'} />
               <SettingsRow
                  title="Installed from"
                  description={current.source === 'url' ? current.sourceUrl : 'Uploaded package'}
               />
            </SettingsCard>
         </SettingsSection>

         {current.configFields.length > 0 ? (
            <SettingsSection
               title="Settings"
               action={
                  <Button
                     size="xs"
                     variant="ghost"
                     disabled={plugin.saving}
                     onClick={() => void saveConfig()}
                  >
                     Save
                  </Button>
               }
            >
               <PluginConfigForm
                  fields={current.configFields}
                  value={config}
                  onChange={setConfig}
                  disabled={plugin.saving}
               />
            </SettingsSection>
         ) : null}

         {current.secrets.length > 0 ? (
            <SettingsSection
               title="Secrets"
               description="Stored encrypted and sent only to the plugin"
            >
               <SettingsCard>
                  {current.secrets.map((secret) => (
                     <SettingsRow
                        key={secret.name}
                        title={secret.name}
                        description={secret.set ? 'Set' : secret.description || 'Not set'}
                        trailing={
                           <span className="flex items-center gap-2">
                              <Input
                                 type="password"
                                 autoComplete="off"
                                 className="h-8 w-44"
                                 placeholder={secret.set ? 'Replace…' : 'Value'}
                                 value={secretDrafts[secret.name] ?? ''}
                                 onChange={(event) =>
                                    setSecretDrafts((drafts) => ({
                                       ...drafts,
                                       [secret.name]: event.target.value,
                                    }))
                                 }
                              />
                              <Button
                                 size="xs"
                                 variant="ghost"
                                 onClick={() => void saveSecret(secret.name)}
                              >
                                 Save
                              </Button>
                              {secret.set ? (
                                 <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => void clearSecret(secret.name)}
                                 >
                                    Clear
                                 </Button>
                              ) : null}
                           </span>
                        }
                     />
                  ))}
               </SettingsCard>
            </SettingsSection>
         ) : null}

         {current.mcpTools.length > 0 ? (
            <SettingsSection
               title="Agent tools"
               description="Agents can use only the tools approved here"
            >
               <SettingsCard>
                  {current.mcpTools.map((tool) => (
                     <SettingsRow
                        key={tool.name}
                        title={tool.name}
                        description={tool.description || undefined}
                        trailing={
                           <Switch
                              checked={tool.approved}
                              disabled={plugin.saving}
                              onCheckedChange={(v) => void approve(tool.name, v)}
                           />
                        }
                     />
                  ))}
               </SettingsCard>
            </SettingsSection>
         ) : null}

         {current.surfaces.length > 0 ? (
            <SettingsSection title="Pages">
               <SettingsCard>
                  {current.surfaces.map((surface) => (
                     <SettingsRow
                        key={surface.key}
                        title={surface.title}
                        trailing={
                           <Link
                              href={`/${orgId}/plugins/${pluginId}/${surface.key}`}
                              className="inline-flex items-center gap-1 hover:underline"
                           >
                              Open <ExternalLink className="size-3.5" />
                           </Link>
                        }
                     />
                  ))}
               </SettingsCard>
            </SettingsSection>
         ) : null}

         <SettingsSection title="Hooks">
            <SettingsCard>
               {current.hooks.length === 0 ? (
                  <SettingsRow title="None" />
               ) : (
                  current.hooks.map((hook) => (
                     <SettingsRow
                        key={hook.key}
                        title={hook.key}
                        description={
                           hook.trigger === 'event'
                              ? `On ${(hook.events ?? []).join(', ')}`
                              : `Every ${hook.everyMinutes ?? 0} minutes`
                        }
                     />
                  ))
               )}
            </SettingsCard>
         </SettingsSection>

         <SettingsSection
            title="Recent calls"
            description={invocations.error ?? undefined}
            action={
               <Button size="xs" variant="ghost" onClick={() => invocations.reload()}>
                  Refresh
               </Button>
            }
         >
            <SettingsCard>
               {(invocations.value ?? []).length === 0 ? (
                  <SettingsRow title={invocations.loading ? 'Loading…' : 'No calls yet'} />
               ) : (
                  (invocations.value ?? []).map((call) => (
                     <SettingsRow
                        key={call.id}
                        muted={call.status === 'error'}
                        title={`${call.kind} · ${call.trigger}`}
                        description={[
                           new Date(call.createdAt).toLocaleString(),
                           call.httpStatus === null ? null : `HTTP ${call.httpStatus}`,
                           `${call.durationMs} ms`,
                           call.error,
                        ]
                           .filter(Boolean)
                           .join(' · ')}
                        trailing={call.status === 'ok' ? 'OK' : 'Failed'}
                     />
                  ))
               )}
            </SettingsCard>
         </SettingsSection>

         <SettingsSection
            title="Stored data"
            description={storage.error ?? 'Keys this plugin has saved'}
         >
            <SettingsCard>
               {(storage.value ?? []).length === 0 ? (
                  <SettingsRow title={storage.loading ? 'Loading…' : 'Nothing stored'} />
               ) : (
                  (storage.value ?? []).map((entry) => (
                     <SettingsRow
                        key={entry.key}
                        title={<code className="font-mono">{entry.key}</code>}
                        description={JSON.stringify(entry.value).slice(0, 160)}
                     />
                  ))
               )}
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title="Danger zone">
            <SettingsCard>
               <SettingsRow
                  title="Uninstall"
                  description="Deletes its settings, secrets, storage and history."
                  trailing={
                     <Button
                        size="xs"
                        variant="ghost"
                        className="text-status-danger hover:text-status-danger"
                        onClick={() => void uninstall()}
                     >
                        Uninstall
                     </Button>
                  }
               />
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
