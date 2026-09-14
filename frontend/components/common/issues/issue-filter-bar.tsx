'use client';

import { DataTableFilter } from '@/components/data-table-filter';
import { useDataTableFilters } from '@/components/data-table-filter/hooks/use-data-table-filters';
import { SaveViewDialog } from '@/components/common/views/save-view-dialog';
import { Button } from '@/components/ui/button';
import { BerryApiError } from '@/lib/api';
import { updateSavedView } from '@/lib/views';
import { useFilterStore } from '@/store/filter-store';
import { useIssuesStore } from '@/store/issues-store';
import { useViewsStore } from '@/store/views-store';
import { BookmarkPlus, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useIssueFilterColumns } from './issue-filter-columns';
import { useIssueListView } from './use-issue-list-view';
import { WorkingAgentsChip } from './working-agents-chip';

/**
 * The applied-filters row: the working-agents chip, the filter chips
 * (subject / operator / values / remove), an icon button to add more filters
 * and a Clear action. Filter state lives in the URL (see filter-store).
 *
 * From here a set of chips can become a view — a new one, or an update to the
 * view being looked at — because that is the moment someone knows the filter
 * was worth keeping.
 */
export function IssueFilterBar() {
   const t = useTranslations('issueLists');
   const { issues } = useIssuesStore();
   const { filters, setFilters } = useFilterStore();
   const issueFilterColumns = useIssueFilterColumns();
   const view = useIssueListView();
   const { viewId } = useParams<{ viewId?: string }>();
   const savedView = useViewsStore((state) => (viewId ? state.getViewById(viewId) : undefined));
   const hydrateViews = useViewsStore((state) => state.hydrateViews);
   const views = useViewsStore((state) => state.views);
   const [saveOpen, setSaveOpen] = useState(false);
   const [saving, setSaving] = useState(false);

   const { columns, actions, strategy } = useDataTableFilters({
      strategy: 'client',
      data: issues,
      columnsConfig: issueFilterColumns,
      filters,
      onFiltersChange: setFilters,
   });

   const saveIntoView = () => {
      if (!savedView || saving) return;
      setSaving(true);
      void updateSavedView(savedView.id, {
         query: { filters: JSON.parse(JSON.stringify(filters)) as unknown },
         display: {
            ...savedView.display,
            layout: view.mode,
            grouping: view.grouping,
            ordering: view.ordering,
            direction: view.direction,
         },
         revision: savedView.revision,
      })
         .then((updated) => {
            hydrateViews(
               views.map((entry) =>
                  entry.id === savedView.id
                     ? { ...entry, revision: updated.revision, savedFilters: filters }
                     : entry
               )
            );
            toast.success(t('filters.savedToView'));
         })
         .catch((cause: unknown) => {
            // The server refuses a save built on a revision someone else has
            // already moved past, which is the one failure worth its own words.
            const stale =
               cause instanceof BerryApiError &&
               (cause.status === 409 || cause.code.includes('CONFLICT'));
            toast.error(stale ? t('views.conflict') : t('states.loadFailed'));
         })
         .finally(() => setSaving(false));
   };

   if (filters.length === 0) {
      return (
         <div className="w-full px-6 py-2 empty:hidden">
            <WorkingAgentsChip />
         </div>
      );
   }

   return (
      <>
         <div className="flex w-full flex-wrap items-center gap-2 border-b border-border/60 bg-container px-6 py-2">
            <WorkingAgentsChip />
            <div className="min-w-0 flex-1">
               <DataTableFilter
                  columns={columns}
                  filters={filters}
                  actions={actions}
                  strategy={strategy}
               />
            </div>
            <div className="flex shrink-0 items-center gap-1">
               <Button size="xs" variant="ghost" onClick={() => setSaveOpen(true)}>
                  <BookmarkPlus className="mr-1 size-3.5" />
                  {t('filters.saveAsView')}
               </Button>
               {savedView ? (
                  <Button size="xs" variant="ghost" disabled={saving} onClick={saveIntoView}>
                     <Save className="mr-1 size-3.5" />
                     {t('filters.saveToView')}
                  </Button>
               ) : null}
            </div>
         </div>
         <SaveViewDialog open={saveOpen} onOpenChange={setSaveOpen} />
      </>
   );
}
