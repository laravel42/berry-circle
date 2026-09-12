'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { subscribeWorkspaceEvents } from '@/lib/events';
import {
   GITHUB_EVENTS,
   addWorkspaceRepositories,
   describeGitHubFailure,
   isRepositoryUrl,
   listWorkspaceRepositories,
   loadGitHubSettings,
   removeWorkspaceRepository,
   updateWorkspaceRepository,
   type WorkspaceRepository,
} from '@/lib/github';
import { loadGitHubApp, startGitHubInstall, type GitHubAppState } from '@/lib/integrations';
import { useSessionStore } from '@/store/session-store';
import { Plus, Trash2 } from 'lucide-react';
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
         const [repositories, state, appState] = await Promise.all([
            listWorkspaceRepositories(workspaceId),
            loadGitHubSettings(workspaceId),
            loadGitHubApp().catch(() => null),
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
               message: row.url.trim() ? 'Use an https:// or ssh address.' : 'Enter a repository URL.',
            });
            return;
         }
         const sent = { url: row.url.trim(), description: row.description.trim() };
         patchRow(key, { status: 'saving', message: null });
         try {
            if (row.id === null) {
               const [created] = await addWorkspaceRepositories(workspaceId, [sent]);
               if (!created) {
                  patchRow(key, { status: 'error', message: 'That repository is already in the list.' });
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
                  ...(sent.description !== row.saved.description ? { description: sent.description } : {}),
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
      [workspaceId, patchRow]
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

   return (
      <SettingsShell
         title="Repositories"
         description="The repositories this workspace works in, each with a note on what it holds. Changes save as you type."
      >
         {!canManage && loaded && !error && (
            <p className="text-muted-foreground">Only workspace admins can change this list.</p>
         )}

         {/* No installation: the one thing worth saying before the list, because
             every row in it would be a repository no agent can reach. The link
             is the same one a first login offers — skipping it there costs the
             access, not the account. */}
         {loaded && !error && access?.app && !access.installation && (
            <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2.5">
               <p className="text-muted-foreground">
                  {access.installPending
                     ? 'Berry has no repository access yet: an owner of that organisation was asked to approve the install, and nothing else is needed from you until they do.'
                     : 'Berry has no repository access yet. Installing the GitHub App is where you choose which repositories it may reach.'}
               </p>
               {canManage && (
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
                     {installing ? 'Opening…' : 'Install on GitHub'}
                  </Button>
               )}
            </div>
         )}
         {canManage && (
            <div className="flex flex-wrap gap-2">
               <Button size="xs" onClick={addRow}>
                  <Plus className="size-3.5" />
                  Add repository
               </Button>
               <Button
                  size="xs"
                  variant="secondary"
                  disabled={!installed || !workspaceId}
                  title={installed ? undefined : 'Connect GitHub in Integrations first'}
                  onClick={() => setPickerOpen(true)}
               >
                  Import from GitHub
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
               Loading repositories…
            </p>
         )}
         {loaded && !error && rows.length === 0 && (
            <p className="text-muted-foreground">
               No repositories yet.{' '}
               {canManage ? 'Add one by URL, or import from GitHub.' : ''}
            </p>
         )}

         {rows.length > 0 && (
            <ul className="flex flex-col gap-2">
               {rows.map((row) => (
                  <li key={row.key} className="rounded-lg border bg-container px-3 py-2.5">
                     <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                        <Input
                           aria-label="Repository URL"
                           placeholder="https://github.com/owner/repo"
                           className="h-8 font-mono sm:flex-[3]"
                           value={row.url}
                           disabled={!canManage}
                           onChange={(event) => edit(row.key, 'url', event.target.value)}
                           onBlur={() => saveNow(row.key)}
                        />
                        <Input
                           aria-label="Description"
                           placeholder="What this repository holds"
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
                              aria-label="Remove repository"
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
                              ? 'Saving…'
                              : row.status === 'saved'
                                ? 'Saved'
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
