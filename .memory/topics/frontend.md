# Frontend

- 2026-08-22 — Circle template (MIT, upstream `7785985`) vendored into `frontend/`, demo data stripped, rebranded to Berry (BERR-28). Notice stays in `frontend/LICENSE.md`.
- 2026-08-22 — Stack from `frontend/package.json`: Next.js App Router, React 19, Tailwind v4, shadcn/Radix, Zustand, nuqs, Zod 4. Tooling is Bun + Prettier 3-space + ESLint. README/playbook still say Next 15 — trust `package.json`.
- 2026-08-22 — Gateway seam: `lib/config.ts` + `lib/api.ts`. Empty `NEXT_PUBLIC_BERRY_API_URL` boots with no data. Board/issue wiring is BERR-29/30.
- 2026-08-22 — `data/*` keeps Circle domain types and empty arrays; `store/*` seeds from them. Do not restore mock datasets. `currentUser` is a pre-auth placeholder.
- 2026-08-22 — Design-system baseline is `docs/design-system.md`. Semantic tokens only; proposed status/actor aliases are not implemented. Circle comments saying "Linear-style" are leftover, not a brand license.
