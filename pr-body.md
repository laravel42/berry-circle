## What

Vendors the [Circle template](https://github.com/ln-dev7/circle) (Next.js + shadcn/ui + Tailwind) as the Berry frontend and removes the entire mock-data layer.

## Changes

- **Vendored** the full Circle template source into the repo
- **Stripped mock data**: `mock-data/` → `lib/domain/` — all data arrays emptied, types preserved, stub functions ready for API integration
- **API client**: `lib/api.ts` reads `NEXT_PUBLIC_API_URL` from env (defaults to `http://localhost:3001`)
- **Stores**: initialize empty; no seed data shipped
- **Config**: `.env.local.example` added; `.gitignore` covers `.env*`
- **Build**: passes with zero errors

## Structure

```
lib/domain/          # Domain types + empty data collections
  issues.ts            # Issue type + helpers (groupIssuesByStatus, etc.)
  users.ts             # User type
  teams.ts             # Team type
  projects.ts          # Project type + health config
  cycles.ts            # Cycle type + status labels
  views.ts             # View type + filter helpers
  reviews.ts           # Review type
  status.tsx           # Status workflow config (icons, colors)
  priorities.tsx       # Priority config (icons)
  ...                  # etc.
lib/api.ts           # Gateway API client (NEXT_PUBLIC_API_URL)
store/               # Zustand stores (empty init)
```

## Testing

```bash
pnpm install
pnpm build    # passes
pnpm dev      # boots empty against gateway
```
