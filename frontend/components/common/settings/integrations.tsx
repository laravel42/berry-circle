'use client';

import { BerryMark } from '@/components/brand/berry-mark';
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
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   BUILT_IN_PROVIDER,
   describeConnectionResult,
   describeIntegrationFailure,
   describeProviderState,
   describeToolEffect,
   disconnectProvider,
   listConnections,
   listGrants,
   listProviders,
   startAuthorize,
   toolKind,
   toolOperation,
   type Provider,
   type ProviderConnection,
   type ProviderTool,
   type ToolGrant,
} from '@/lib/integrations';
import { cn } from '@/lib/utils';
import { useProvidersStore } from '@/store/providers-store';
import { useSessionStore } from '@/store/session-store';
import { format, parseISO } from 'date-fns';
import { ChevronDown, Search } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { INTEGRATION_LOGOS } from './integration-logos';
import { SettingsShell } from './shared';

function ProviderIcon({ provider }: { provider: Provider }) {
   if (provider.id === BUILT_IN_PROVIDER) {
      return (
         <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
            <BerryMark size="sm" />
         </span>
      );
   }
   const Logo = INTEGRATION_LOGOS[provider.id];
   if (Logo) {
      return (
         <span
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border bg-background"
            aria-hidden
         >
            <Logo className="size-[60%]" />
         </span>
      );
   }
   const initials = provider.name
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase();
   return (
      <span
         className="inline-flex size-9 shrink-0 select-none items-center justify-center rounded-md border bg-accent font-medium text-accent-foreground"
         aria-hidden
      >
         {initials}
      </span>
   );
}

function whenText(iso: string | null | undefined): string {
   if (!iso) return '';
   try {
      return format(parseISO(iso), 'd MMM yyyy, HH:mm');
   } catch {
      return iso;
   }
}

function ToolsTable({ provider, grants }: { provider: Provider; grants: ToolGrant[] }) {
   const granted = (tool: ProviderTool): string | null => {
      const match = grants.find(
         (grant) =>
            grant.provider === provider.id &&
            !grant.agentId &&
            (grant.tool === tool.name || grant.tool === '*')
      );
      return match ? match.maxEffect : null;
   };
   return (
      <div className="overflow-x-auto">
         <table className="w-full min-w-[36rem] border-t border-border/60">
            <thead>
               <tr className="text-left text-muted-foreground">
                  <th className="px-4 py-1.5 font-medium">Tool</th>
                  <th className="px-2 py-1.5 font-medium">Kind</th>
                  <th className="px-2 py-1.5 font-medium">Effect</th>
                  <th className="px-2 py-1.5 font-medium">Approval</th>
                  <th className="px-2 py-1.5 font-medium">Default</th>
                  {provider.id !== BUILT_IN_PROVIDER && (
                     <th className="px-2 py-1.5 pr-4 font-medium">Granted</th>
                  )}
               </tr>
            </thead>
            <tbody>
               {provider.tools.map((tool) => {
                  const kind = toolKind(tool);
                  const grant = granted(tool);
                  return (
                     <tr key={tool.name} className="border-t border-border/40 align-top">
                        <td className="px-4 py-1.5">
                           <span className="font-mono">{toolOperation(tool.name)}</span>
                           {tool.description && (
                              <span className="block max-w-xs text-muted-foreground">
                                 {tool.description}
                              </span>
                           )}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">{kind}</td>
                        <td
                           className={cn(
                              'px-2 py-1.5',
                              tool.effect === 'destructive'
                                 ? 'text-status-danger'
                                 : tool.effect === 'external_side_effect'
                                   ? 'text-status-warning'
                                   : 'text-muted-foreground'
                           )}
                        >
                           {describeToolEffect(tool.effect)}
                        </td>
                        <td className="px-2 py-1.5">
                           {tool.requiresApproval ? (
                              <span className="text-status-warning">required</span>
                           ) : (
                              <span className="text-muted-foreground">—</span>
                           )}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                           {tool.enabledByDefault === false ? 'opt-in' : 'on'}
                        </td>
                        {provider.id !== BUILT_IN_PROVIDER && (
                           <td className="px-2 py-1.5 pr-4 text-muted-foreground">
                              {grant ? `every agent · ${describeToolEffect(grant)}` : '—'}
                           </td>
                        )}
                     </tr>
                  );
               })}
            </tbody>
         </table>
      </div>
   );
}

function ProviderCard({
   provider,
   connection,
   grants,
   highlighted,
   busy,
   onConnect,
   onDisconnect,
}: {
   provider: Provider;
   connection: ProviderConnection | undefined;
   grants: ToolGrant[];
   highlighted: boolean;
   busy: boolean;
   onConnect: () => void;
   onDisconnect: () => void;
}) {
   const [toolsOpen, setToolsOpen] = useState(false);
   const state = describeProviderState(provider);
   const builtIn = provider.id === BUILT_IN_PROVIDER;
   const approvals = provider.tools.filter((tool) => tool.requiresApproval).length;
   const destructive = provider.tools.filter((tool) => tool.effect === 'destructive').length;
   const triggers = provider.tools.filter((tool) => toolKind(tool) === 'trigger').length;
   const scopes = connection?.scopes?.length ? connection.scopes : (provider.scopes ?? []);
   return (
      <section
         id={`provider-${provider.id}`}
         className={cn(
            'rounded-lg border bg-container transition-shadow',
            highlighted && 'ring-2 ring-ring/50'
         )}
         aria-label={provider.name}
      >
         <div className="flex items-start gap-3 px-4 py-3">
            <ProviderIcon provider={provider} />
            <div className="min-w-0 flex-1">
               <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h3 className="font-medium">{provider.name}</h3>
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-0.5 text-muted-foreground">
                     <BerryMark
                        size="sm"
                        tone={state.tone}
                        state={state.tone === 'complete' ? 'solid' : 'hollow'}
                     />
                     {state.label}
                  </span>
               </div>
               {provider.description && (
                  <p className="mt-0.5 text-muted-foreground">{provider.description}</p>
               )}
               {provider.connected && (
                  <p className="mt-1 text-muted-foreground">
                     {connection?.accountName || provider.accountName
                        ? `as ${connection?.accountName ?? provider.accountName}`
                        : 'connected'}
                     {connection?.createdAt && ` · since ${whenText(connection.createdAt)}`}
                     {connection?.expiresAt && ` · token expires ${whenText(connection.expiresAt)}`}
                     {connection?.statusDetail && ` · ${connection.statusDetail}`}
                  </p>
               )}
               {!builtIn && !provider.configured && (
                  <p className="mt-1 text-muted-foreground">
                     Not configured on this deployment: set the {provider.name} OAuth credentials to
                     enable Connect.
                  </p>
               )}
               {builtIn && (
                  <p className="mt-1 text-muted-foreground">
                     Runs inside Berry; workflows use these tools with nothing to connect.
                  </p>
               )}
               {scopes.length > 0 && (
                  <ul className="mt-1.5 flex flex-wrap gap-1">
                     {scopes.map((scope) => (
                        <li
                           key={scope}
                           className="rounded border border-border/60 bg-muted/40 px-1.5 font-mono leading-5 text-muted-foreground"
                        >
                           {scope}
                        </li>
                     ))}
                  </ul>
               )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
               {!builtIn && provider.connected && (
                  <Button size="xs" variant="secondary" disabled={busy} onClick={onDisconnect}>
                     {busy ? 'Working…' : 'Disconnect'}
                  </Button>
               )}
               {!builtIn && !provider.connected && (
                  <Button
                     size="xs"
                     disabled={busy || !provider.configured}
                     title={
                        provider.configured
                           ? `Sign in to ${provider.name}`
                           : `${provider.name} is not configured on this deployment`
                     }
                     onClick={onConnect}
                  >
                     {busy ? 'Opening…' : 'Connect'}
                  </Button>
               )}
            </div>
         </div>
         <button
            type="button"
            className="flex w-full items-center gap-1.5 border-t border-border/60 px-4 py-2 text-left text-muted-foreground transition-colors hover:bg-accent/40"
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen((open) => !open)}
         >
            <ChevronDown
               className={cn(
                  'size-3.5 transition-transform',
                  toolsOpen ? 'rotate-0' : '-rotate-90'
               )}
            />
            {provider.tools.length} tool{provider.tools.length === 1 ? '' : 's'}
            {triggers > 0 && ` · ${triggers} trigger${triggers === 1 ? '' : 's'}`}
            {approvals > 0 && ` · ${approvals} need${approvals === 1 ? 's' : ''} approval`}
            {destructive > 0 && (
               <span className="text-status-danger"> · {destructive} destructive</span>
            )}
         </button>
         {toolsOpen && <ToolsTable provider={provider} grants={grants} />}
      </section>
   );
}

function IntegrationsDirectory() {
   const status = useSessionStore((state) => state.status);
   const workspace = useSessionStore((state) => state.workspace);
   const hydrateProviders = useProvidersStore((state) => state.hydrateProviders);
   const searchParams = useSearchParams();
   const router = useRouter();
   const pathname = usePathname();

   const [providers, setProviders] = useState<Provider[]>([]);
   const [connections, setConnections] = useState<ProviderConnection[]>([]);
   const [grants, setGrants] = useState<ToolGrant[]>([]);
   const [loaded, setLoaded] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const [query, setQuery] = useState('');
   const [busy, setBusy] = useState<string | null>(null);
   const [disconnecting, setDisconnecting] = useState<Provider | null>(null);

   const load = useCallback(async () => {
      if (!workspace) return;
      try {
         const [providerList, connectionList, grantList] = await Promise.all([
            listProviders(workspace.id),
            listConnections().catch(() => [] as ProviderConnection[]),
            listGrants().catch(() => [] as ToolGrant[]),
         ]);
         setProviders(providerList);
         setConnections(connectionList);
         setGrants(grantList);
         hydrateProviders(providerList);
         setError(null);
      } catch (failure) {
         setError(describeIntegrationFailure(failure));
      } finally {
         setLoaded(true);
      }
   }, [workspace, hydrateProviders]);

   useEffect(() => {
      if (status !== 'ready' || !workspace) return;
      void load();
   }, [status, workspace, load]);

   // The provider sends the browser back here with the outcome in the query;
   // it is said once and then taken off the address so a reload stays quiet.
   const announced = useRef<string | null>(null);
   const callbackProvider = searchParams.get('integration');
   const callbackStatus = searchParams.get('status');
   useEffect(() => {
      if (!callbackProvider || !callbackStatus) return;
      const key = `${callbackProvider}:${callbackStatus}`;
      if (announced.current === key) return;
      announced.current = key;
      const name =
         providers.find((provider) => provider.id === callbackProvider)?.name ??
         callbackProvider.charAt(0).toUpperCase() + callbackProvider.slice(1);
      const outcome = describeConnectionResult(callbackStatus, name);
      if (outcome.ok) toast.success(outcome.message);
      else toast.error(outcome.message);
      router.replace(`${pathname}?provider=${encodeURIComponent(callbackProvider)}`);
   }, [callbackProvider, callbackStatus, providers, router, pathname]);

   const highlighted = searchParams.get('provider');
   useEffect(() => {
      if (!highlighted || !loaded) return;
      document.getElementById(`provider-${highlighted}`)?.scrollIntoView({ block: 'center' });
   }, [highlighted, loaded]);

   const connect = async (provider: Provider) => {
      setBusy(provider.id);
      try {
         const url = await startAuthorize(provider.id);
         window.location.assign(url);
      } catch (failure) {
         toast.error(describeIntegrationFailure(failure));
         setBusy(null);
      }
   };

   const disconnect = async (provider: Provider) => {
      setBusy(provider.id);
      try {
         await disconnectProvider(provider.id);
         toast.success(`${provider.name} disconnected`);
         await load();
      } catch (failure) {
         toast.error(describeIntegrationFailure(failure));
      } finally {
         setBusy(null);
      }
   };

   const visible = useMemo(() => {
      const needle = query.trim().toLowerCase();
      if (!needle) return providers;
      return providers.filter(
         (provider) =>
            provider.name.toLowerCase().includes(needle) ||
            provider.id.includes(needle) ||
            provider.tools.some((tool) => tool.name.toLowerCase().includes(needle))
      );
   }, [providers, query]);

   const connected = providers.filter((provider) => provider.connected).length;

   return (
      <SettingsShell
         title="Integrations"
         description="Connect the tools workflows and agents may reach. Berry's own tools need no connection; a workflow that names another provider stays a draft until it is connected."
      >
         <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
               placeholder="Search providers and tools"
               value={query}
               onChange={(event) => setQuery(event.target.value)}
               className="h-9 pl-8"
               aria-label="Search providers and tools"
            />
         </div>

         {error && (
            <p role="alert" className="text-status-danger">
               {error}
            </p>
         )}
         {!loaded && !error && (
            <p role="status" className="text-muted-foreground">
               Loading providers…
            </p>
         )}
         {loaded && !error && (
            <p className="text-muted-foreground" role="status">
               {providers.length} provider{providers.length === 1 ? '' : 's'} · {connected}{' '}
               connected
               {visible.length !== providers.length && ` · ${visible.length} shown`}
            </p>
         )}

         <div className="flex flex-col gap-3">
            {visible.map((provider) => (
               <ProviderCard
                  key={provider.id}
                  provider={provider}
                  connection={connections.find((entry) => entry.provider === provider.id)}
                  grants={grants}
                  highlighted={highlighted === provider.id}
                  busy={busy === provider.id}
                  onConnect={() => void connect(provider)}
                  onDisconnect={() => setDisconnecting(provider)}
               />
            ))}
            {loaded && visible.length === 0 && !error && (
               <p className="text-muted-foreground">No provider matches.</p>
            )}
         </div>

         <AlertDialog
            open={disconnecting !== null}
            onOpenChange={(open) => !open && setDisconnecting(null)}
         >
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect {disconnecting?.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                     Every grant on this connection goes with it. Active workflows that use{' '}
                     {disconnecting?.name ?? 'it'} will fail at that step until it is connected
                     again.
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                  <AlertDialogAction
                     className={buttonVariants({ variant: 'destructive' })}
                     onClick={() => {
                        const target = disconnecting;
                        setDisconnecting(null);
                        if (target) void disconnect(target);
                     }}
                  >
                     Disconnect
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </SettingsShell>
   );
}

/**
 * Workspace integrations: every provider the deployment knows, whether it
 * is connected, what each one's tools may do, and Connect / Disconnect
 * through the OAuth flow the API runs. Reached from the Connect action on
 * a plan or a workflow with `?provider=` naming what to connect.
 */
export default function Integrations() {
   return (
      <Suspense fallback={null}>
         <IntegrationsDirectory />
      </Suspense>
   );
}
