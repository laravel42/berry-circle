'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
   addWorkspaceRepositories,
   describeGitHubFailure,
   loadGitHubRepositories,
   type PickerRepository,
} from '@/lib/github';
import { cn } from '@/lib/utils';
import { Archive, Lock, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 300;

/** Why a repository cannot be chosen, or null when it can. */
function unavailable(repository: PickerRepository): string | null {
   if (repository.alreadyAdded) return 'Already in the list';
   if (repository.archived) return 'Archived';
   return null;
}

/**
 * Choose repositories the GitHub App can reach and add them to the workspace.
 *
 * Archived repositories and ones already listed are shown but cannot be
 * ticked, with the reason beside them — hiding them would leave someone
 * searching for a repository the picker knows about.
 */
export function GitHubImportPicker({
   workspaceId,
   open,
   onOpenChange,
   onImported,
}: {
   workspaceId: string;
   open: boolean;
   onOpenChange: (open: boolean) => void;
   onImported: () => void;
}) {
   const [accounts, setAccounts] = useState<string[]>([]);
   const [account, setAccount] = useState('');
   const [query, setQuery] = useState('');
   const [search, setSearch] = useState('');
   const [repositories, setRepositories] = useState<PickerRepository[]>([]);
   const [total, setTotal] = useState(0);
   const [cursor, setCursor] = useState<string | null>(null);
   const [loading, setLoading] = useState(false);
   const [loadingMore, setLoadingMore] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const [selected, setSelected] = useState<Map<number, PickerRepository>>(new Map());
   const [importing, setImporting] = useState(false);
   // The newest request wins: a slow answer to an old search must not
   // replace the list for the search that followed it.
   const generation = useRef(0);

   useEffect(() => {
      const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DEBOUNCE_MS);
      return () => clearTimeout(timer);
   }, [query]);

   const loadFirst = useCallback(async () => {
      const mine = ++generation.current;
      setLoading(true);
      setError(null);
      try {
         const page = await loadGitHubRepositories(workspaceId, {
            account,
            q: search,
            limit: PAGE_SIZE,
         });
         if (mine !== generation.current) return;
         setAccounts(page.accounts);
         setRepositories(page.repositories);
         setTotal(page.total);
         setCursor(page.nextCursor ?? null);
      } catch (failure) {
         if (mine === generation.current) setError(describeGitHubFailure(failure));
      } finally {
         if (mine === generation.current) setLoading(false);
      }
   }, [workspaceId, account, search]);

   useEffect(() => {
      if (open) void loadFirst();
   }, [open, loadFirst]);

   useEffect(() => {
      if (!open) {
         setSelected(new Map());
         setQuery('');
         setSearch('');
      }
   }, [open]);

   const loadMore = async () => {
      if (!cursor) return;
      const mine = generation.current;
      setLoadingMore(true);
      try {
         const page = await loadGitHubRepositories(workspaceId, {
            account,
            q: search,
            cursor,
            limit: PAGE_SIZE,
         });
         if (mine !== generation.current) return;
         setRepositories((current) => [...current, ...page.repositories]);
         setCursor(page.nextCursor ?? null);
      } catch (failure) {
         toast.error(describeGitHubFailure(failure));
      } finally {
         setLoadingMore(false);
      }
   };

   const toggle = (repository: PickerRepository, checked: boolean) => {
      setSelected((current) => {
         const next = new Map(current);
         if (checked) next.set(repository.id, repository);
         else next.delete(repository.id);
         return next;
      });
   };

   const importSelected = async () => {
      const chosen = [...selected.values()];
      if (chosen.length === 0) return;
      setImporting(true);
      try {
         const added = await addWorkspaceRepositories(
            workspaceId,
            chosen.map((repository) => ({
               url: repository.url,
               description: (repository.description ?? '').slice(0, 500),
               githubRepoId: repository.id,
            }))
         );
         toast.success(
            added.length === 1 ? 'Added 1 repository' : `Added ${added.length} repositories`
         );
         onImported();
         onOpenChange(false);
      } catch (failure) {
         toast.error(describeGitHubFailure(failure));
      } finally {
         setImporting(false);
      }
   };

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-xl">
            <DialogHeader>
               <DialogTitle>Import from GitHub</DialogTitle>
               <DialogDescription>
                  Repositories the Berry GitHub App can reach. Pick the ones this workspace works
                  in.
               </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap gap-2">
               <select
                  aria-label="GitHub account"
                  className="h-9 rounded-md border bg-background px-2 text-foreground"
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
               >
                  <option value="">All accounts</option>
                  {accounts.map((login) => (
                     <option key={login} value={login}>
                        {login}
                     </option>
                  ))}
               </select>
               <div className="relative min-w-[12rem] flex-1">
                  <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                     placeholder="Search repositories"
                     aria-label="Search repositories"
                     value={query}
                     onChange={(event) => setQuery(event.target.value)}
                     className="h-9 pl-8"
                  />
               </div>
            </div>

            <div className="min-h-[12rem] flex-1 overflow-y-auto rounded-md border">
               {error && (
                  <p role="alert" className="p-4 text-status-danger">
                     {error}
                  </p>
               )}
               {!error && loading && (
                  <p role="status" className="p-4 text-muted-foreground">
                     Loading repositories…
                  </p>
               )}
               {!error && !loading && repositories.length === 0 && (
                  <p className="p-4 text-muted-foreground">
                     {search || account
                        ? 'No repository matches.'
                        : 'The App cannot reach any repository yet. Grant it access on GitHub.'}
                  </p>
               )}
               {!error && !loading && repositories.length > 0 && (
                  <ul className="divide-y divide-border/60">
                     {repositories.map((repository) => {
                        const reason = unavailable(repository);
                        const id = `import-${repository.id}`;
                        return (
                           <li
                              key={repository.id}
                              className={cn('flex items-start gap-3 px-3 py-2', reason && 'opacity-60')}
                           >
                              <Checkbox
                                 id={id}
                                 className="mt-0.5"
                                 disabled={reason !== null}
                                 checked={selected.has(repository.id)}
                                 onCheckedChange={(checked) => toggle(repository, checked === true)}
                              />
                              <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                                 <span className="flex items-center gap-1.5 font-medium">
                                    <span className="truncate">{repository.fullName}</span>
                                    {repository.private && (
                                       <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Private" />
                                    )}
                                    {repository.archived && (
                                       <Archive className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                                    )}
                                 </span>
                                 {repository.description && (
                                    <span className="block truncate text-muted-foreground">
                                       {repository.description}
                                    </span>
                                 )}
                              </label>
                              {reason && <span className="shrink-0 text-muted-foreground">{reason}</span>}
                           </li>
                        );
                     })}
                  </ul>
               )}
               {cursor && !loading && !error && (
                  <div className="border-t border-border/60 p-2 text-center">
                     <Button size="xs" variant="secondary" disabled={loadingMore} onClick={() => void loadMore()}>
                        {loadingMore ? 'Loading…' : `Load more (${total - repositories.length} left)`}
                     </Button>
                  </div>
               )}
            </div>

            <DialogFooter className="items-center gap-2 sm:justify-between">
               <span className="text-muted-foreground">{selected.size} selected</span>
               <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => onOpenChange(false)}>
                     Cancel
                  </Button>
                  <Button disabled={selected.size === 0 || importing} onClick={() => void importSelected()}>
                     {importing
                        ? 'Importing…'
                        : selected.size === 1
                          ? 'Import 1 repository'
                          : `Import ${selected.size} repositories`}
                  </Button>
               </div>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
