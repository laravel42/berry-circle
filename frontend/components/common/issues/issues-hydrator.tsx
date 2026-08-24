'use client';

import { useHydrateWorkspaceData } from '@/hooks/use-hydrate-workspace-data';

/**
 * Client boundary that loads Go API data into the shared stores.
 * Mounted from MainLayout so board, project, and inbox pages share one fetch.
 */
export function IssuesHydrator() {
   useHydrateWorkspaceData();
   return null;
}
