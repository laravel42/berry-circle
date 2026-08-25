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
import { loadGitHubRepositories, setProjectRepository, type GitHubRepository } from '@/lib/projects';
import { useProjectsStore } from '@/store/projects-store';
import { Check, Github, Loader2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * Chooses the GitHub repository a project delivers into.
 *
 * The list is loaded when the picker opens rather than with the page. It costs
 * an upstream call and most people looking at a project are not relinking it,
 * so paying for it on every project view would be a request nobody asked for.
 */
export function RepositorySelector({ project }: { project: Project }) {
   const updateProject = useProjectsStore((state) => state.updateProject);
   const [open, setOpen] = useState(false);
   const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
   const [loading, setLoading] = useState(false);
   const [error, setError] = useState<string | null>(null);
   const [saving, setSaving] = useState(false);

   useEffect(() => {
      if (!open || repositories.length > 0) return;
      let cancelled = false;
      setLoading(true);
      setError(null);
      loadGitHubRepositories()
         .then((loaded) => {
            if (!cancelled) setRepositories(loaded);
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
      async (fullName: string | null) => {
         const previous = project.githubRepo;
         setSaving(true);
         updateProject(project.id, { githubRepo: fullName ?? undefined });
         setOpen(false);
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
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               variant="ghost"
               size="sm"
               className="w-full justify-start gap-2 px-1.5"
               disabled={saving}
            >
               {saving ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" />
               ) : (
                  <Github className="size-4 shrink-0 text-muted-foreground" />
               )}
               <span className={project.githubRepo ? 'truncate' : 'truncate text-muted-foreground'}>
                  {project.githubRepo ?? 'Link a repository'}
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
                           {project.githubRepo ? (
                              <CommandItem onSelect={() => void choose(null)}>
                                 <X className="size-4" /> Unlink
                              </CommandItem>
                           ) : null}
                           {repositories.map((repository) => (
                              <CommandItem
                                 key={repository.id}
                                 value={repository.fullName}
                                 onSelect={() => void choose(repository.fullName)}
                              >
                                 <Github className="size-4 shrink-0" />
                                 <span className="truncate">{repository.fullName}</span>
                                 {project.githubRepo === repository.fullName ? (
                                    <Check className="ml-auto size-4" />
                                 ) : null}
                              </CommandItem>
                           ))}
                        </CommandGroup>
                     </>
                  )}
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );
}
