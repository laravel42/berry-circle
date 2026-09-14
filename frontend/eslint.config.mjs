import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
   baseDirectory: __dirname,
});

/* A Tailwind font-size utility -- the named scale or an arbitrary length --
   with any variant prefixes (`md:`, `file:`, `[&_svg]:`) in front of it.
   Colour utilities such as `text-muted-foreground` and layout ones such as
   `text-balance` deliberately fall outside it. */
const FONT_SIZE_UTILITY = String.raw`(^|\s)([^\s]*:)?text-(xs|sm|base|lg|xl|[2-9]xl|\[[0-9.]+(px|rem|em|pt)\])(\s|$)`;

/* Type size is decided by the element, in the base layer of app/globals.css:
   h1 text-xl, h2 text-lg, h3 text-base, h4 text-sm, everything else text-xs.
   Utilities live in a later cascade layer, so a single `text-lg` in a
   component silently outranks that whole scheme -- which is why none are
   allowed rather than only the wrong ones. Reach for the right element
   instead; if a case genuinely needs its own size, it belongs in globals.css
   next to the rest of the scale, not inline. */
const TYPE_SCALE_MESSAGE =
   'Font sizes come from the element (h1-h4, else text-xs) via the base layer in app/globals.css. Use the right element, or add the exception to globals.css -- do not set a text-* size utility here.';

/* Fixture collections and surfaces with no backend. The frontend talks to
   Berry only; an import from this list would render an empty fake instead of
   real data, or bring a hidden surface back into navigation. Each workstream
   task that removes a fixture adds its entry here so it cannot return. */
const FIXTURE_IMPORT_PATHS = [
   {
      name: '@/data/side-bar-nav',
      message: 'The legacy sidebar is gone; navigation lives in shell-routes.ts and nav-settings.tsx.',
   },
   {
      name: '@/data/documents',
      message: 'Documents have no backend and are hidden from navigation.',
   },
   {
      name: '@/components/common/settings/settings-placeholder',
      message: 'Placeholder settings pages are hidden, not faked. Build a real settings page instead.',
   },
   {
      name: '@/data/cycles',
      message: 'Cycles have no backend and are hidden from navigation.',
   },
   {
      name: '@/data/initiatives',
      message: 'Initiatives have no backend and are hidden from navigation.',
   },
   {
      name: '@/components/common/cycles/cycle-icon',
      message: 'Cycles have no backend and are hidden from navigation.',
   },
   {
      name: '@/data/users',
      importNames: ['users'],
      message: 'Members come from useMembersStore, hydrated from the API.',
   },
   {
      name: '@/data/labels',
      importNames: ['labels'],
      message: 'Labels come from useLabelsStore, hydrated from the API.',
   },
   {
      name: '@/data/projects',
      importNames: ['projects', 'getProjectById', 'getProjectsByTeam'],
      message: 'Projects come from useProjectsStore, hydrated from the API.',
   },
   {
      name: '@/data/issues',
      importNames: ['issues'],
      message: 'Issues come from useIssuesStore, hydrated from the API.',
   },
   {
      name: '@/data/inbox',
      importNames: ['inboxItems'],
      message: 'Notifications come from the inbox API.',
   },
   {
      name: '@/data/views',
      importNames: ['views', 'issueViews', 'projectViews', 'getViewsByTeam', 'getViewById'],
      message: 'Saved views come from useViewsStore, hydrated from the API.',
   },
];

const eslintConfig = [
   ...compat.extends('next/core-web-vitals', 'next/typescript'),
   {
      files: ['**/*.{ts,tsx}'],
      rules: {
         'no-restricted-imports': ['error', { paths: FIXTURE_IMPORT_PATHS }],
         'no-restricted-syntax': [
            'error',
            {
               selector: `Literal[value=/${FONT_SIZE_UTILITY}/]`,
               message: TYPE_SCALE_MESSAGE,
            },
            {
               selector: `TemplateElement[value.raw=/${FONT_SIZE_UTILITY}/]`,
               message: TYPE_SCALE_MESSAGE,
            },
         ],
      },
   },
   {
      // Vendored bazza/ui data-table-filter (kept close to upstream for easy updates)
      files: ['components/data-table-filter/**/*.{ts,tsx}'],
      rules: {
         '@typescript-eslint/no-unused-vars': 'off',
         '@typescript-eslint/no-explicit-any': 'off',
         '@typescript-eslint/no-this-alias': 'off',
         'react-hooks/rules-of-hooks': 'off',
         'react-hooks/exhaustive-deps': 'off',
      },
   },
];

export default eslintConfig;
