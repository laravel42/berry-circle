'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   installPlugin,
   loadPlugins,
   previewPlugin,
   type PluginConfigValue,
   type PluginInstallation,
   type PluginPreview,
   type PluginSource,
} from '@/lib/plugins';
import { useSessionStore } from '@/store/session-store';
import { Loader2, Puzzle } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PluginConfigForm } from './plugin-config-form';
import { EnabledDot, SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

/**
 * Workspace "Plugins": what is installed, and installing another.
 *
 * Installing is two steps on purpose. The preview lists every scope, event,
 * schedule, surface and tool the package asks for before anything is stored,
 * so an admin agrees to a list rather than to a URL.
 */
export default function PluginsSettings() {
   const router = useRouter();
   const { orgId } = useParams<{ orgId: string }>();
   const workspace = useSessionStore((state) => state.workspace);
   const workspaceId = workspace?.id ?? '';
   const plugins = useSettingsResource<PluginInstallation[]>(
      () =>
         workspaceId
            ? loadPlugins(workspaceId)
            : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );

   const [url, setUrl] = useState('');
   const [source, setSource] = useState<PluginSource | null>(null);
   const [preview, setPreview] = useState<PluginPreview | null>(null);
   const [config, setConfig] = useState<Record<string, PluginConfigValue>>({});
   const [busy, setBusy] = useState(false);
   const [signingSecret, setSigningSecret] = useState<string | null>(null);

   const runPreview = async (next: PluginSource) => {
      setBusy(true);
      try {
         setPreview(await previewPlugin(workspaceId, next));
         setSource(next);
         setConfig({});
      } catch (cause) {
         setPreview(null);
         toast.error(cause instanceof Error ? cause.message : 'The package could not be read.');
      } finally {
         setBusy(false);
      }
   };

   const onFile = async (file: File | undefined) => {
      if (!file) return;
      try {
         const parsed: unknown = JSON.parse(await file.text());
         await runPreview({ package: parsed });
      } catch {
         toast.error('That file is not a plugin package (berry-plugin.json).');
      }
   };

   const install = async () => {
      if (!source) return;
      setBusy(true);
      try {
         const created = await installPlugin(workspaceId, source, config);
         plugins.set([...(plugins.value ?? []), created.installation]);
         setSigningSecret(created.signingSecret);
         setPreview(null);
         setSource(null);
         setUrl('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The plugin could not be installed.');
      } finally {
         setBusy(false);
      }
   };

   return (
      <SettingsShell
         title="Plugins"
         description="Extend this workspace with hooks, pages and agent tools"
      >
         <SettingsSection title="Installed" description={plugins.error ?? undefined}>
            <SettingsCard>
               {plugins.loading ? (
                  <SettingsRow title="Loading…" />
               ) : (plugins.value ?? []).length === 0 ? (
                  <SettingsRow title="No plugins yet" description="Install one below." />
               ) : (
                  (plugins.value ?? []).map((plugin) => (
                     <SettingsRow
                        key={plugin.id}
                        icon={<Puzzle className="size-4" />}
                        title={plugin.name}
                        description={`${plugin.key} · v${plugin.version}`}
                        trailing={plugin.enabled ? <EnabledDot>Enabled</EnabledDot> : 'Disabled'}
                        chevron
                        onClick={() => router.push(`/${orgId}/settings/plugins/${plugin.id}`)}
                     />
                  ))
               )}
            </SettingsCard>
            {signingSecret ? (
               <div className="mt-2 rounded-md border border-status-warning/40 bg-container px-4 py-3">
                  <p className="font-medium">
                     Signing secret — give it to the plugin now. It is not shown again.
                  </p>
                  <code className="mt-1.5 block break-all font-mono text-muted-foreground">
                     {signingSecret}
                  </code>
                  <Button
                     size="xs"
                     variant="ghost"
                     className="mt-2 -ml-2"
                     onClick={() => {
                        void navigator.clipboard?.writeText(signingSecret);
                        setSigningSecret(null);
                     }}
                  >
                     Copy and dismiss
                  </Button>
               </div>
            ) : null}
         </SettingsSection>

         <SettingsSection
            title="Install a plugin"
            description="From a URL that serves berry-plugin.json, or by uploading the file"
         >
            <SettingsCard>
               <SettingsRow
                  title="From a URL"
                  trailing={
                     <span className="flex items-center gap-2">
                        <Input
                           value={url}
                           placeholder="https://…/berry-plugin.json"
                           className="h-8 w-64"
                           onChange={(event) => setUrl(event.target.value)}
                        />
                        <Button
                           size="xs"
                           variant="ghost"
                           disabled={busy || url.trim() === ''}
                           onClick={() => void runPreview({ url: url.trim() })}
                        >
                           Preview
                        </Button>
                     </span>
                  }
               />
               <SettingsRow
                  title="Upload a package"
                  trailing={
                     <Input
                        type="file"
                        accept=".json,application/json"
                        className="h-8 w-64"
                        disabled={busy}
                        onChange={(event) => void onFile(event.target.files?.[0])}
                     />
                  }
               />
            </SettingsCard>
         </SettingsSection>

         {preview ? (
            <SettingsSection
               title={`${preview.name} v${preview.version}`}
               description={preview.description || preview.baseUrl}
               action={
                  <Button size="sm" disabled={busy} onClick={() => void install()}>
                     {busy ? <Loader2 className="size-3.5 animate-spin" /> : 'Install'}
                  </Button>
               }
            >
               <SettingsCard>
                  <SettingsRow title="Calls" description={preview.baseUrl} />
                  <SettingsRow
                     title="Access to this workspace"
                     description={preview.scopes.length ? preview.scopes.join(', ') : 'None'}
                  />
                  <SettingsRow
                     title="Notified about"
                     description={preview.events.length ? preview.events.join(', ') : 'No events'}
                  />
                  <SettingsRow
                     title="Runs on a schedule"
                     description={
                        preview.schedules.length
                           ? preview.schedules
                                .map((s) => `${s.key} every ${s.everyMinutes} min`)
                                .join(', ')
                           : 'No'
                     }
                  />
                  <SettingsRow
                     title="Pages"
                     description={preview.surfaces.map((s) => s.title).join(', ') || 'None'}
                  />
                  <SettingsRow
                     title="Agent tools (each needs approval after install)"
                     description={preview.mcpTools.join(', ') || 'None'}
                  />
                  <SettingsRow
                     title="Secrets it will ask for"
                     description={preview.secrets.map((s) => s.name).join(', ') || 'None'}
                  />
                  <SettingsRow
                     title="Files"
                     description={preview.files.map((f) => f.path).join(', ') || 'None'}
                  />
               </SettingsCard>
               <PluginConfigForm
                  fields={preview.config}
                  value={config}
                  onChange={setConfig}
                  disabled={busy}
               />
            </SettingsSection>
         ) : null}
      </SettingsShell>
   );
}
