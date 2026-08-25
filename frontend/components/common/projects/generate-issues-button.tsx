'use client';

import { Button } from '@/components/ui/button';
import type { Project } from '@/data/projects';
import { BerryApiError } from '@/lib/api';
import { loadBoardIssues } from '@/lib/issues';
import { generateProjectIssues } from '@/lib/projects';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';
import { Loader2, Sparkles } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

/**
 * Asks an agent to break a project into issues.
 *
 * It costs a model call and takes as long as one, so the button says so while
 * it works rather than appearing inert. There is no confirmation: the result is
 * a set of issues someone can read and delete, which is a cheaper mistake to
 * undo than the dialog would be to sit through every time.
 */
export function GenerateIssuesButton({ project }: { project: Project }) {
   const boardId = useSessionStore((state) => state.boardId);
   const hydrateIssues = useIssuesStore((state) => state.hydrateIssues);
   const [working, setWorking] = useState(false);

   const generate = useCallback(async () => {
      setWorking(true);
      try {
         const created = await generateProjectIssues(project.id);
         // Refetched rather than inserted from the response: the new issues
         // need their board ordering and project link resolved the same way
         // every other issue does, and one path for that is fewer than two.
         if (boardId) {
            hydrateIssues(await loadBoardIssues(boardId));
         }
         toast.success(
            created.length === 1
               ? '1 issue generated'
               : `${created.length} issues generated`
         );
      } catch (cause) {
         toast.error(
            cause instanceof BerryApiError ? cause.message : 'Issues could not be generated.'
         );
      } finally {
         setWorking(false);
      }
   }, [project.id, boardId, hydrateIssues]);

   return (
      <Button
         variant="ghost"
         size="sm"
         className="gap-1.5"
         disabled={working}
         onClick={() => void generate()}
      >
         {working ? (
            <Loader2 className="size-4 animate-spin" />
         ) : (
            <Sparkles className="size-4" />
         )}
         {working ? 'Generating…' : 'Generate issues'}
      </Button>
   );
}
