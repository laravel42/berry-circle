'use client';

import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Project } from '@/data/projects';
import { BerryApiError } from '@/lib/api';
import {
   loadGitHubRepositories,
   setProjectRepository,
   type GitHubAccess,
   type GitHubRepository,
} from '@/lib/projects';
import { useProjectsStore } from '@/store/projects-store';
import { Check, Github, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * Chooses a GitHub repository, over a plain value.
 *
 * Split from the project-bound wrapper below because the create dialog has no
 * project to update yet — it holds a pending choice until the project exists.
 * Both need the same list, search and failure states, and having two would mean
 * one of them quietly falling behind.
 *
 * The list is loaded when the picker opens rather than with the page. It costs
 * an upstream call and most people looking at a project are not relinking it,
 * so paying for it on every view would be a request nobody asked for.
 */
export function RepositoryPicker({
   value,
   onSelect,
   disabled,
   placeholder = 'Link a repository',
}: {
   value?: string;
   onSelect: (fullName: string | null) => void;
   disabled?: boolean;
   placeholder?: string;
}) {
   const [open, setOpen] = useState(false);
   const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
   const [access, setAccess] = useState<GitHubAccess | null>(null);
   const [loading, setLoading] = useState(false);
   const [error, setError] = useState<string | null>(null);

   useEffect(() => {
      if (!open || repositories.length > 0) return;
      let cancelled = false;
      setLoading(true);
      setError(null);
      loadGitHubRepositories()
         .then((loaded) => {
            if (cancelled) return;
            setRepositories(loaded.repositories);
            setAccess(loaded.access);
         })
         .catch((cause: unknown) => {
            if (cancelled) return;
            // An empty list and a list that failed to load look identical, and
            // the fixes are opposite — so the reason is shown, not hidden.
            setError(
               cause instanceof BerryApiError
                  ? cause.message
                  : 'Repositories could not be loaded.'
            );
         })
         .finally(() => {
            if (!cancelled) setLoading(false);
         });
      return () => {
         cancelled = true;
      };
   }, [open, repositories.length]);

   const choose = useCallback(
      (fullName: string | null) => {
         setOpen(false);
         onSelect(fullName);
      },
      [onSelect]
   );

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               variant="ghost"
               size="sm"
               className="w-full justify-start gap-2 px-1.5"
               disabled={disabled}
            >
               {disabled ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" />
               ) : (
                  <Github className="size-4 shrink-0 text-muted-foreground" />
               )}
               <span className={value ? 'truncate' : 'truncate text-muted-foreground'}>
                  {value ?? placeholder}
               </span>
            </Button>
         </PopoverTrigger>

         <PopoverContent className="w-72 p-0" align="start">
            <Command>
               <CommandInput placeholder="Search repositories…" />
               <CommandList>
                  {loading ? (
                     <div className="flex items-center gap-2 px-3 py-4 text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> Loading…
                     </div>
                  ) : error ? (
                     <div className="px-3 py-4 text-destructive">{error}</div>
                  ) : (
                     <>
                        <CommandEmpty>No repository found.</CommandEmpty>
                        <CommandGroup>
                           {value ? (
                              <CommandItem onSelect={() => choose(null)}>
                                 <X className="size-4" /> Unlink
                              </CommandItem>
                           ) : null}
                           {repositories.map((repository) => (
                              <CommandItem
                                 key={repository.id}
                                 value={repository.fullName}
                                 onSelect={() => choose(repository.fullName)}
                              >
                                 <Github className="size-4 shrink-0" />
                                 <span className="truncate">{repository.fullName}</span>
                                 {value === repository.fullName ? (
                                    <Check className="ml-auto size-4" />
                                 ) : null}
                              </CommandItem>
                           ))}
                        </CommandGroup>
                     </>
                  )}
               </CommandList>
               {/* Without an installation a user token reads only public
                   repositories, which looks like a broken picker rather than a
                   missing install. That is the one case worth a footer; once the
                   app is installed the list speaks for itself. */}
               {access && !access.installed ? (
                  <div className="border-t px-3 py-2 text-muted-foreground">
                     Only public repositories are visible.{' '}
                     {access.installUrl ? (
                        <a
                           href={access.installUrl}
                           target="_blank"
                           rel="noreferrer"
                           className="text-foreground underline underline-offset-2"
                        >
                           Install the app
                        </a>
                     ) : null}
                     .
                  </div>
               ) : null}
            </Command>
         </PopoverContent>
      </Popover>
   );
}

/**
 * The picker bound to an existing project, saving as soon as a choice is made.
 *
 * The local change is rolled back if the request fails, because a repository
 * that looks linked and is not is the failure this whole path exists to avoid.
 */
export function RepositorySelector({ project }: { project: Project }) {
   const updateProject = useProjectsStore((state) => state.updateProject);
   const [saving, setSaving] = useState(false);

   const save = useCallback(
      async (fullName: string | null) => {
         const previous = project.githubRepo;
         setSaving(true);
         updateProject(project.id, { githubRepo: fullName ?? undefined });
         try {
            await setProjectRepository(project.id, fullName);
            toast.success(fullName ? `Linked to ${fullName}` : 'Repository unlinked');
         } catch (cause) {
            updateProject(project.id, { githubRepo: previous });
            toast.error(
               cause instanceof BerryApiError ? cause.message : 'That repository could not be saved.'
            );
         } finally {
            setSaving(false);
         }
      },
      [project.id, project.githubRepo, updateProject]
   );

   return (
      <RepositoryPicker
         value={project.githubRepo}
         onSelect={(fullName) => void save(fullName)}
         disabled={saving}
      />
   );
}
