'use client';

import { parseAsArrayOf, parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';

export type ProjectsSort =
   'title-asc' | 'title-desc' | 'date-asc' | 'date-desc' | 'status-asc' | 'status-desc';

const SORTS: ProjectsSort[] = [
   'title-asc',
   'title-desc',
   'date-asc',
   'date-desc',
   'status-asc',
   'status-desc',
];

/** The facets a project list can be narrowed by. */
export type ProjectsFilterType = 'health' | 'priority' | 'status' | 'lead';

export interface ProjectsFilterState {
   filters: {
      health: string[]; // health ids
      priority: string[]; // priority ids
      status: string[]; // project status ids
      lead: string[]; // member ids
   };
   sort: ProjectsSort;
   /** Free-text search over project names. */
   query: string;

   setSort: (sort: ProjectsSort) => void;
   setQuery: (query: string) => void;
   setFilter: (type: ProjectsFilterType, ids: string[]) => void;
   toggleFilter: (type: ProjectsFilterType, id: string) => void;
   clearFilters: () => void;
   clearFilterType: (type: ProjectsFilterType) => void;

   hasActiveFilters: () => boolean;
   getActiveFiltersCount: () => number;
}

const parsers = {
   health: parseAsArrayOf(parseAsString).withDefault([]),
   priority: parseAsArrayOf(parseAsString).withDefault([]),
   status: parseAsArrayOf(parseAsString).withDefault([]),
   lead: parseAsArrayOf(parseAsString).withDefault([]),
   q: parseAsString.withDefault(''),
   sort: parseAsStringLiteral(SORTS).withDefault('title-asc'),
};

/** Projects page filters, search and sorting, URL-synced via nuqs. */
export function useProjectsFilterStore(): ProjectsFilterState {
   const [state, setState] = useQueryStates(parsers, { history: 'replace' });

   const filters = {
      health: state.health,
      priority: state.priority,
      status: state.status,
      lead: state.lead,
   };

   return {
      filters,
      sort: state.sort,
      query: state.q,

      setSort: (sort) => setState({ sort: sort === 'title-asc' ? null : sort }),
      setQuery: (query) => setState({ q: query.trim() === '' ? null : query }),
      setFilter: (type, ids) => setState({ [type]: ids.length > 0 ? ids : null }),
      toggleFilter: (type, id) => {
         const current = filters[type];
         const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
         setState({ [type]: next.length > 0 ? next : null });
      },
      clearFilters: () =>
         setState({ health: null, priority: null, status: null, lead: null, q: null }),
      clearFilterType: (type) => setState({ [type]: null }),

      hasActiveFilters: () =>
         Object.values(filters).some((arr) => arr.length > 0) || state.q.trim() !== '',
      getActiveFiltersCount: () =>
         Object.values(filters).reduce((sum, arr) => sum + arr.length, 0) +
         (state.q.trim() === '' ? 0 : 1),
   };
}
