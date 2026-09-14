'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { subscribeWorkspaceEvents } from '@/lib/events';
import {
   GITHUB_EVENTS,
   addWorkspaceRepositories,
   describeAccount,
   describeGitHubFailure,
   isRepositoryUrl,
   listWorkspaceRepositories,
   loadGitHubSettings,
   loadGrantedRepositories,
   refreshGrantedRepositories,
   removeWorkspaceRepository,
   updateWorkspaceRepository,
   type GrantedRepositories,
   type WorkspaceRepository,
} from '@/lib/github';
import { loadGitHubApp, startGitHubInstall, type GitHubAppState } from '@/lib/integrations';
import { useSessionStore } from '@/store/session-store';
import { Lock, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { GitHubImportPicker } from './github-import-picker';
import { SettingsShell } from './shared';

const AUTOSAVE_DELAY_MS = 600;

type RowStatus = 'idle' | 'saving' | 'saved' | 'error';

interface Row {
   /** Stable React key; a new row has no server id until its first save. */
   key: string;
   id: string | null;
   url: string;
   description: string;
   /** What the server last confirmed, so only real changes are sent. */
   saved: { url: string; description: string };
   status: RowStatus;
   message: string | null;
}

function fromServer(repository: WorkspaceRepository): Row {
   return {
      key: repository.id,
      id: repository.id,
      url: repository.url,
      description: repository.description,
      saved: { url: repository.url, description: repository.description },
      status: 'idle',
      message: null,
   };
}

function dirty(row: Row): boolean {
   return row.url !== row.saved.url || row.description !== row.saved.description;
}

function RepositoriesDirectory() {
   const t = useTranslations('workspaceAdmin.repositories');
   // The two words every settings page that autosaves says, said the same way.
   const tSave = useTranslations('workspaceAdmin.save');
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const searchParams = useSearchParams();
   const router = useRouter();
   const pathname = usePathname();

   const [rows, setRows] = useState<Row[]>([]);
   const rowsRef = useRef<Row[]>([]);
   const [loaded, setLoaded] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const [canManage, setCanManage] = useState(false);
   const [installed, setInstalled] = useState(false);
   /**
    * What Berry can reach, for the person who skipped the install at their
    * first login. They have an account and this page; what they do not have is
    * repository access, and this is where that is said and offered again.
    */
   const [access, setAccess] = useState<GitHubAppState | null>(null);
   const [installing, setInstalling] = useState(false);
   /**
    * What GitHub granted, as Berry recorded it — the access the list below runs
    * on. Read from Berry rather than GitHub: the only credential that can ask
    * GitHub is the signed-in person's own token, and this page has to work for
    * whoever opens it.
    */
   const [granted, setGranted] = useState<GrantedRepositories | null>(null);
   const [refreshing, setRefreshing] = useState(false);
   /** A refusal from the last refresh, which is where "sign in again" is said. */
   const [grantError, setGrantError] = useState<string | null>(null);
   const [pickerOpen, setPickerOpen] = useState(false);
   const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

   const commit = useCallback((next: Row[]) => {
      rowsRef.current = next;
      setRows(next);
   }, []);

   const patchRow = useCallback(
      (key: string, change: Partial<Row>) => {
         commit(rowsRef.current.map((row) => (row.key === key ? { ...row, ...change } : row)));
      },
      [commit]
   );

   const load = useCallback(async () => {
      if (!workspaceId) return;
      try {
         const [repositories, state, appState, grantState] = await Promise.all([
            listWorkspaceRepositories(workspaceId),
            loadGitHubSettings(workspaceId),
            loadGitHubApp().catch(() => null),
            // Its own failure, because an unreadable grant must not empty the
            // list of repositories somebody is editing.
            loadGrantedRepositories(workspaceId).catch(() => null),
         ]);
         // Rows someone is editing survive a refresh; everything else takes
         // the server's word.
         const editing = rowsRef.current.filter((row) => dirty(row) || row.status === 'saving');
         const editingIds = new Set(editing.map((row) => row.id));
         commit([
            ...repositories.map((repository) =>
               editingIds.has(repository.id)
                  ? (editing.find((row) => row.id === repository.id) ?? fromServer(repository))
                  : fromServer(repository)
            ),
            ...editing.filter((row) => row.id === null),
         ]);
         setCanManage(state.canManage);
         setInstalled(state.connection.installed && state.settings.enabled);
         setAccess(appState);
         setGranted(grantState);
         setError(null);
      } catch (failure) {
         setError(describeGitHubFailure(failure));
      } finally {
         setLoaded(true);
      }
   }, [workspaceId, commit]);

   useEffect(() => {
      void load();
   }, [load]);

   useEffect(
      () =>
         subscribeWorkspaceEvents((event) => {
            if (event.workspaceId && event.workspaceId !== workspaceId) return;
            if (
               event.type === GITHUB_EVENTS.repositories ||
               event.type === GITHUB_EVENTS.connection ||
               event.type === GITHUB_EVENTS.settings
            ) {
               void load();
            }
         }),
      [workspaceId, load]
   );

   // Arriving from a fresh install opens the picker once, then the address
   // is cleaned so a reload does not open it again.
   useEffect(() => {
      if (searchParams.get('import') !== 'github' || !loaded) return;
      if (canManage && installed) setPickerOpen(true);
      router.replace(pathname);
   }, [searchParams, loaded, canManage, installed, router, pathname]);

   useEffect(() => {
      const pending = timers.current;
      return () => {
         for (const timer of pending.values()) clearTimeout(timer);
      };
   }, []);

   const save = useCallback(
      async (key: string) => {
         const row = rowsRef.current.find((candidate) => candidate.key === key);
         if (!row || !workspaceId || !dirty(row)) return;
         if (!isRepositoryUrl(row.url)) {
            patchRow(key, {
               status: 'error',
               message: row.url.trim() ? t('urlInvalid') : t('urlRequired'),
            });
            return;
         }
         const sent = { url: row.url.trim(), description: row.description.trim() };
         patchRow(key, { status: 'saving', message: null });
         try {
            if (row.id === null) {
               const [created] = await addWorkspaceRepositories(workspaceId, [sent]);
               if (!created) {
                  patchRow(key, {
                     status: 'error',
                     message: t('duplicate'),
                  });
                  return;
               }
               patchRow(key, {
                  id: created.id,
                  saved: { url: created.url, description: created.description },
                  status: 'saved',
               });
            } else {
               const updated = await updateWorkspaceRepository(workspaceId, row.id, {
                  ...(sent.url !== row.saved.url ? { url: sent.url } : {}),
                  ...(sent.description !== row.saved.description
                     ? { description: sent.description }
                     : {}),
               });
               patchRow(key, {
                  saved: { url: updated.url, description: updated.description },
                  status: 'saved',
               });
            }
         } catch (failure) {
            patchRow(key, { status: 'error', message: describeGitHubFailure(failure) });
         }
      },
      [workspaceId, patchRow, t]
   );

   const schedule = (key: string) => {
      const existing = timers.current.get(key);
      if (existing) clearTimeout(existing);
      timers.current.set(
         key,
         setTimeout(() => {
            timers.current.delete(key);
            void save(key);
         }, AUTOSAVE_DELAY_MS)
      );
   };

   const saveNow = (key: string) => {
      const existing = timers.current.get(key);
      if (existing) clearTimeout(existing);
      timers.current.delete(key);
      void save(key);
   };

   const edit = (key: string, field: 'url' | 'description', value: string) => {
      patchRow(key, { [field]: value, status: 'idle', message: null });
      schedule(key);
   };

   const addRow = () => {
      const key = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      commit([
         ...rowsRef.current,
         {
            key,
            id: null,
            url: '',
            description: '',
            saved: { url: '', description: '' },
            status: 'idle',
            message: null,
         },
      ]);
   };

   const remove = async (row: Row) => {
      const timer = timers.current.get(row.key);
      if (timer) clearTimeout(timer);
      timers.current.delete(row.key);
      commit(rowsRef.current.filter((candidate) => candidate.key !== row.key));
      if (!row.id || !workspaceId) return;
      try {
         await removeWorkspaceRepository(workspaceId, row.id);
      } catch (failure) {
         toast.error(describeGitHubFailure(failure));
         void load();
      }
   };

   const refreshAccess = async () => {
      if (!workspaceId) return;
      setRefreshing(true);
      setGrantError(null);
      try {
         setGranted(await refreshGrantedRepositories(workspaceId));
      } catch (failure) {
         setGrantError(describeGitHubFailure(failure));
      } finally {
         setRefreshing(false);
      }
   };

   /** Grouped by the account the grant came through, in the order the server sent. */
   const grantsByAccount = (granted?.accounts ?? []).map((account) => ({
      account,
      repositories: (granted?.repositories ?? []).filter(
         (repository) => repository.installationId === account.installationId
      ),
   }));

   return (
      <SettingsShell title={t('title')} description={t('lead')}>
         {!canManage && loaded && !error && (
            <p className="text-muted-foreground">{t('readOnly')}</p>
         )}

         {/* What GitHub actually granted, before the list of repositories this
             workspace works in: every row below it would be unreachable without
             this, and an empty section here is the explanation for an empty
             picker. Each state says the one thing left to do. */}
         {loaded && !error && (
            <section className="flex flex-col gap-2">
               <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                     <h3 className="font-medium">{t('grantedTitle')}</h3>
                     <p className="text-muted-foreground">
                        {granted?.refreshedAt
                           ? t('grantedAsOf', {
                                time: new Date(granted.refreshedAt).toLocaleString(),
                             })
                           : t('grantedLead')}
                     </p>
                  </div>
                  {canManage && (
                     <Button
                        size="xs"
                        variant="secondary"
                        disabled={refreshing || !workspaceId}
                        onClick={() => void refreshAccess()}
                     >
                        <RefreshCw className={refreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
                        {refreshing ? t('refreshing') : t('refresh')}
                     </Button>
                  )}
               </div>

               {grantError && (
                  <p role="alert" className="text-status-danger">
                     {grantError}
                  </p>
               )}

               {(granted?.claimedElsewhere ?? []).filter(Boolean).length > 0 && (
                  <p className="text-muted-foreground">
                     {t('claimedElsewhere', {
                        accounts: (granted?.claimedElsewhere ?? []).filter(Boolean).join(', '),
                     })}
                  </p>
               )}

               {/* Nothing granted yet. Which sentence depends on why, and every
                   one of them names the next step — including the one only an
                   operator can take. */}
               {(granted?.repositories.length ?? 0) === 0 && (
                  <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
                     <p className="text-muted-foreground">
                        {/* The operator's reason comes from the server, which
                            words it for whoever configured the deployment. */}
                        {access?.installReason
                           ? access.installReason
                           : granted?.installPending
                             ? t('installPending')
                             : t('noAccess')}
                     </p>
                     {canManage && !access?.installReason && !granted?.installPending && (
                        <Button
                           size="xs"
                           className="mt-2"
                           disabled={installing}
                           onClick={() => {
                              setInstalling(true);
                              void startGitHubInstall()
                                 .then((url) => {
                                    window.location.href = url;
                                 })
                                 .catch((failure: unknown) => {
                                    toast.error(describeGitHubFailure(failure));
                                    setInstalling(false);
                                 });
                           }}
                        >
                           {installing ? t('installing') : t('install')}
                        </Button>
                     )}
                  </div>
               )}

               {grantsByAccount.map(({ account, repositories }) => (
                  <div
                     key={account.installationId}
                     className="rounded-lg border bg-container px-3 py-2.5"
                  >
                     <p className="font-medium">
                        {describeAccount(account)}{' '}
                        <span className="text-muted-foreground font-normal">
                           {t('accountMeta', {
                              id: account.installationId,
                              count: account.repositories,
                           })}
                        </span>
                     </p>
                     <ul className="mt-1 flex flex-col gap-1">
                        {repositories.map((repository) => (
                           <li key={repository.id} className="flex flex-wrap items-center gap-2">
                              <a
                                 href={repository.url}
                                 target="_blank"
                                 rel="noreferrer"
                                 className="font-mono hover:underline"
                              >
                                 {repository.fullName}
                              </a>
                              {repository.private && (
                                 <span
                                    className="text-muted-foreground inline-flex items-center gap-1"
                                    title={t('private')}
                                 >
                                    <Lock className="size-3" />
                                    {t('private')}
                                 </span>
                              )}
                              {repository.defaultBranch && (
                                 <span className="text-muted-foreground font-mono">
                                    {repository.defaultBranch}
                                 </span>
                              )}
                           </li>
                        ))}
                     </ul>
                  </div>
               ))}
            </section>
         )}
         {canManage && (
            <div className="flex flex-wrap gap-2">
               <Button size="xs" onClick={addRow}>
                  <Plus className="size-3.5" />
                  {t('add')}
               </Button>
               <Button
                  size="xs"
                  variant="secondary"
                  disabled={!installed || !workspaceId}
                  title={installed ? undefined : t('importNeedsGitHub')}
                  onClick={() => setPickerOpen(true)}
               >
                  {t('import')}
               </Button>
            </div>
         )}

         {error && (
            <p role="alert" className="text-status-danger">
               {error}
            </p>
         )}
         {!loaded && !error && (
            <p role="status" className="text-muted-foreground">
               {t('loading')}
            </p>
         )}
         {loaded && !error && rows.length === 0 && (
            <p className="text-muted-foreground">{canManage ? t('emptyManage') : t('empty')}</p>
         )}

         {rows.length > 0 && (
            <ul className="flex flex-col gap-2">
               {rows.map((row) => (
                  <li key={row.key} className="rounded-lg border bg-container px-3 py-2.5">
                     <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                        <Input
                           aria-label={t('urlLabel')}
                           placeholder={t('urlPlaceholder')}
                           className="h-8 font-mono sm:flex-[3]"
                           value={row.url}
                           disabled={!canManage}
                           onChange={(event) => edit(row.key, 'url', event.target.value)}
                           onBlur={() => saveNow(row.key)}
                        />
                        <Input
                           aria-label={t('descriptionLabel')}
                           placeholder={t('descriptionPlaceholder')}
                           className="h-8 sm:flex-[4]"
                           maxLength={500}
                           value={row.description}
                           disabled={!canManage}
                           onChange={(event) => edit(row.key, 'description', event.target.value)}
                           onBlur={() => saveNow(row.key)}
                        />
                        {canManage && (
                           <Button
                              size="icon"
                              variant="ghost"
                              className="size-8 shrink-0"
                              aria-label={t('remove')}
                              onClick={() => void remove(row)}
                           >
                              <Trash2 className="size-4" />
                           </Button>
                        )}
                     </div>
                     {(row.status !== 'idle' || row.message) && (
                        <p
                           role={row.status === 'error' ? 'alert' : 'status'}
                           className={
                              row.status === 'error'
                                 ? 'mt-1 text-status-danger'
                                 : 'mt-1 text-muted-foreground'
                           }
                        >
                           {row.status === 'saving'
                              ? tSave('saving')
                              : row.status === 'saved'
                                ? tSave('saved')
                                : row.message}
                        </p>
                     )}
                  </li>
               ))}
            </ul>
         )}

         {workspaceId && (
            <GitHubImportPicker
               workspaceId={workspaceId}
               open={pickerOpen}
               onOpenChange={setPickerOpen}
               onImported={() => void load()}
            />
         )}
      </SettingsShell>
   );
}

/**
 * Settings → Repositories: the workspace's repository list, edited in place
 * with autosave, and the GitHub import picker. `?import=github` opens the
 * picker, which is where a fresh App install lands.
 */
export default function RepositoriesSettings() {
   return (
      <Suspense fallback={null}>
         <RepositoriesDirectory />
      </Suspense>
   );
}
