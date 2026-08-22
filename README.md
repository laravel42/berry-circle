# Berry — Web App

Linear-style team workspace where humans and AI coding agents share one board,
built on top of the Circle template (Next.js + shadcn/ui + Tailwind).

## Stack

- **Framework**: Next.js 15 (App Router)
- **Language**: TypeScript (strict)
- **UI**: shadcn/ui + Radix primitives
- **Styling**: Tailwind CSS 4
- **State**: Zustand + nuqs (URL-synced filters)
- **API**: Berry gateway (BFF) — see `lib/api.ts`

## Getting started

```bash
pnpm install
cp .env.local.example .env.local   # set NEXT_PUBLIC_API_URL
pnpm dev
```

The app boots empty — no mock data is shipped. All domain collections
(`lib/domain/*.ts`) start as empty arrays and are populated from the gateway
API at runtime. See `lib/api.ts` for the fetch client.

## Structure

```
app/            # Next.js App Router pages
components/     # UI components (layout + common)
lib/domain/     # Domain types + empty collections (no mock data)
lib/api.ts      # Gateway API client (NEXT_PUBLIC_API_URL)
store/          # Zustand stores
hooks/          # React hooks
```

## License

MIT — see `LICENSE.md`. Vendored from
[circle](https://github.com/ln-dev7/circle) (MIT).
