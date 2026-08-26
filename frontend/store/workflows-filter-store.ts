'use client';

import { parseAsArrayOf, parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';

export type WorkflowsSort = 'updated-desc' | 'name-asc' | 'runs-desc';

const SORTS: WorkflowsSort[] = ['updated-desc', 'name-asc', 'runs-desc'];

const parsers = {
   status: parseAsArrayOf(parseAsString).withDefault([]),
   trigger: parseAsArrayOf(parseAsString).withDefault([]),
   sort: parseAsStringLiteral(SORTS).withDefault('updated-desc'),
   q: parseAsString.withDefault(''),
};

export interface WorkflowsFilterState {
   status: string[];
   triggerType: string[];
   sort: WorkflowsSort;
   query: string;
   setSort: (sort: WorkflowsSort) => void;
   setQuery: (query: string) => void;
   toggleStatus: (status: string) => void;
   toggleTriggerType: (triggerType: string) => void;
   clearFilters: () => void;
   activeFilterCount: number;
}

/** Workflow list filters, URL-synced (?status=…&trigger=…&sort=…&q=…). */
export function useWorkflowsFilterStore(): WorkflowsFilterState {
   const [state, setState] = useQueryStates(parsers, { history: 'replace' });
   const toggle = (current: string[], value: string) =>
      current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
   return {
      status: state.status,
      triggerType: state.trigger,
      sort: state.sort,
      query: state.q,
      setSort: (sort) => setState({ sort: sort === 'updated-desc' ? null : sort }),
      setQuery: (query) => setState({ q: query || null }),
      toggleStatus: (status) => {
         const next = toggle(state.status, status);
         setState({ status: next.length > 0 ? next : null });
      },
      toggleTriggerType: (triggerType) => {
         const next = toggle(state.trigger, triggerType);
         setState({ trigger: next.length > 0 ? next : null });
      },
      clearFilters: () => setState({ status: null, trigger: null }),
      activeFilterCount: state.status.length + state.trigger.length,
   };
}
