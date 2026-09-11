'use client';

import { parseAsArrayOf, parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';

import { WORKSPACE_ROLES, type WorkspaceRole } from '@/lib/workspaces';

export type MembersSort =
   | 'name-asc'
   | 'name-desc'
   | 'joined-asc' // oldest first
   | 'joined-desc'; // newest first

const SORTS: MembersSort[] = ['name-asc', 'name-desc', 'joined-asc', 'joined-desc'];

const isRole = (value: string): value is WorkspaceRole =>
   (WORKSPACE_ROLES as readonly string[]).includes(value);

export interface MembersFilterState {
   filters: {
      role: WorkspaceRole[];
   };
   sort: MembersSort;

   setSort: (sort: MembersSort) => void;
   setFilter: (type: 'role', ids: string[]) => void;
   toggleFilter: (type: 'role', id: WorkspaceRole) => void;
   clearFilters: () => void;
   clearFilterType: (type: 'role') => void;

   hasActiveFilters: () => boolean;
   getActiveFiltersCount: () => number;
}

const parsers = {
   role: parseAsArrayOf(parseAsString).withDefault([]),
   sort: parseAsStringLiteral(SORTS).withDefault('name-asc'),
};

/**
 * Members page filters + sorting, URL-synced via nuqs (?role=…&sort=…).
 *
 * The roles are Berry's four — owner, admin, member, viewer — not the imported
 * template's Guest/Member/Admin/Application, which named two roles Berry does
 * not have and omitted the two that decide who can administer a workspace. A
 * value in the URL that is not one of the four is dropped rather than filtered
 * on, so an old bookmark shows everyone instead of nobody.
 */
export function useMembersFilterStore(): MembersFilterState {
   const [state, setState] = useQueryStates(parsers, { history: 'replace' });

   const filters = { role: state.role.filter(isRole) };

   return {
      filters,
      sort: state.sort,

      setSort: (sort) => setState({ sort: sort === 'name-asc' ? null : sort }),
      setFilter: (_type, ids) => setState({ role: ids.length > 0 ? ids : null }),
      toggleFilter: (_type, id) => {
         const next = filters.role.includes(id)
            ? filters.role.filter((role) => role !== id)
            : [...filters.role, id];
         setState({ role: next.length > 0 ? next : null });
      },
      clearFilters: () => setState({ role: null }),
      clearFilterType: () => setState({ role: null }),

      hasActiveFilters: () => filters.role.length > 0,
      getActiveFiltersCount: () => filters.role.length,
   };
}
