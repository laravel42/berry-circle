# Berry design-system baseline

This document inventories the imported Circle frontend as implemented on 2026-08-22 and
defines the boundary between reusable UI infrastructure and Berry's own product identity.
It is a source audit, not a claim that every inherited choice is a final Berry standard.

The implementation sources of truth are `frontend/app/globals.css`,
`frontend/components/ui`, and `frontend/components/layout`. Circle remains attributed under
its MIT license in `frontend/LICENSE.md` and in the application sidebar.

## Principles

- Keep semantic tokens and accessible Radix behavior; avoid styling features with raw color
  values or one-off state treatments.
- Berry should be recognizable through its own color, type hierarchy, icon treatment,
  navigation, terminology, and interaction model—not through a close visual reproduction of
  another issue tracker.
- Dense information is appropriate for an operations workspace, but 24–28 px controls are
  compact variants, not the default for primary actions or touch surfaces.
- Human work, agent work, reviews, and run state need equal first-class visual semantics.

## Foundations

### Color

The Brand Manual is the palette authority. `frontend/app/globals.css` exposes these values
through semantic CSS custom properties and Tailwind's `@theme inline`; feature components
consume semantic state names rather than raw colors.

| Brand token | Value | Intended use |
| --- | --- | --- |
| `void` | `#111113` | Dark app canvas and gutters |
| `base` | `#1A1A1D` | Primary dark workspace surface |
| `ember` | `#1C1811` | Human-held or review-waiting surface |
| `thicket` | `#151917` | Completed/merged surface |
| `deep` | `#121820` | Agent output and active run surface |
| `ripe` | `oklch(70% 0.13 85)` | One bright empty-state or primary editorial surface |
| `chalk` | `#F8F8F4` | Dark-theme primary text |
| `ash` | `#A8A6A6` | Dark-theme supporting body text |
| `slate` | `#6A6767` | Metadata on light surfaces only. Dark captions use `ash` so they stay above 4.5:1. |
| `hairline` | `#26262B` | Rules and borders; never body text |
| `berry` | `#C74A5E` | Brand mark, wordmark stop, and one primary action per view |
| `amber` | `#D9A441` | Human input, blocked, awaiting review |
| `verdant` | `#4F9F7A` | Done, accepted, merged |
| `azure` | `#5A92C9` | Agent activity in progress |

Berry Dark is the default product theme. Berry Light is an accessible print-like inversion;
System selects between those two. The inherited `pure-light`, `magic-blue`, `classic-dark`,
and custom theme variants are not Berry themes.

Semantic state aliases keep color meaning stable across both themes:

| Proposed alias | Meaning |
| --- | --- |
| `status-success` | Completed, healthy, connected |
| `status-warning` | At risk, waiting, degraded |
| `status-danger` | Failed, blocked, destructive |
| `status-info` | Informational or running |
| `status-neutral` | Paused, cancelled, inactive |
| `actor-human` | Human-authored activity/avatar accent |
| `actor-agent` | Agent-authored activity/avatar accent |
| `review-pending`, `review-approved`, `review-changes` | Review-gate states |

Berry is never an error color. Destructive/error actions use the separate `status-danger`
token. Status marks retain one bracket silhouette; the berry dot, label, and optional
non-color cue communicate the state.

### Typography

| Role | Current implementation | Guidance |
| --- | --- | --- |
| Interface | Geist Mono 300, 13/20 | Default for controls, body, metadata, identifiers, logs, and durations |
| Display | DM Serif Display | Wordmark, page display titles, and quoted agent handoff only |
| Micro label | 8–11 px, usually medium | Restrict to nonessential badges; never primary content |
| Caption | `text-xs` = 11/16 px | Metadata, timestamps, compact labels |
| Body compact | `text-sm` = 13/20 px | Default dense UI body and controls |
| Body | `text-base` = 14/22 px | Forms and reading surfaces; mobile inputs already force 16 px |
| Heading small | `text-lg` = 16/24 px, semibold | Dialog/card title |
| Heading medium | `text-xl`–`text-2xl` = 18–20 px | Page/section title |
| Display | `text-3xl` = 24/28 px | Rare overview/empty-state emphasis |
| Sidebar menu | `text-sm` = 15/26 px, `text-xs` = 12/16 px | Already compacted; do not inherit the workspace scale |

Form controls inherit `color` and `-webkit-text-fill-color` from `--foreground` in
`globals.css`. Do not rely on the user-agent fill. Placeholders fade
`--foreground` (about 40% opacity), not low-opacity `--muted-foreground`, so they
stay visible on void.

Geist Mono defaults to weight 300. Hierarchy comes from size, tone, and spacing rather than many weights.
DM Serif Display never appears in buttons, controls, tables, or dense queue rows. Prefer the
defined scale over new arbitrary values; migrate recurring 10 px and 11 px labels into named
`type-micro` and `type-overline` styles if they survive accessibility review.

### Spacing and sizing

The frontend uses Tailwind's 4 px spacing base. Its working compact scale is:

| Token | Value | Common use |
| --- | --- | --- |
| `space-0.5` | 2 px | Tight icon alignment only |
| `space-1` | 4 px | Inline icon/text and micro gaps |
| `space-1.5` | 6 px | Compact control gap |
| `space-2` | 8 px | Default internal gap/padding |
| `space-2.5` | 10 px | Compact horizontal padding |
| `space-3` | 12 px | Field/card padding |
| `space-4` | 16 px | Default section/card separation |
| `space-5` | 20 px | Generous component padding |
| `space-6` | 24 px | Dialog/page section padding |
| `space-8` | 32 px | Large section separation |
| `space-10` | 40 px | Empty/loading state breathing room |

Standard control heights are 24, 28, 32, 36, and 40 px (`h-6` through `h-10`). Use 36 px
for normal desktop fields and buttons, 32 px for dense tables/toolbars, and 40 px or greater
for primary mobile actions. The inherited 24/28 px variants are for low-priority desktop
utilities only. Default icons are 16 px; secondary icons use 14 or 12 px.

Layout constants currently embedded in components should move to named tokens when those
components are revised:

- Desktop sidebar: 244 px; mobile drawer: 260 px; collapsed rail: 48 px.
- Desktop workspace inset: 8 px.
- Header accounting: 40 px compact/mobile and 56 px desktop, with two-header totals of
  80/96 px.
- Mobile/navigation behavior changes below 1024 px.

### Shape, elevation, and motion

The root radius is 10 px. Derived semantic radii are 6 px (`sm`), 8 px (`md`), 10 px
(`lg`), and 14 px (`xl`); pills and avatars use `full`. Most controls use 8 px, cards/dialogs
use 10 px, and badges/avatars use a pill. Arbitrary 2, 4, and 5 px radii should be folded
into the scale or explicitly documented as chart/indicator geometry.

Elevation uses Tailwind `shadow-xs` on controls, `shadow-sm` on floating sidebar surfaces,
and `shadow-lg` on dialogs/popovers. Borders, not shadows, provide most hierarchy. Common
motion is 150–200 ms; sheets use 300 ms close and 500 ms open. All new animation must honor
`prefers-reduced-motion`; inherited animated primitives need an audit for that behavior.

## Component inventory

### Reusable primitives

The 33 local shadcn/Radix primitives are the lowest-level design-system layer:

`AlertDialog`, `Alert`, `Avatar`, `Badge`, `Breadcrumb`, `Button`, `Calendar`, `Card`,
`Checkbox`, `Collapsible`, `Command`, `ContextMenu`, `Dialog`, `DropdownMenu`, `Form`,
`Input`, `Label`, `Popover`, `Progress`, `Resizable`, `Select`, `Separator`, `Sheet`,
`Sidebar`, `Skeleton`, `Slider`, `Sonner`, `Switch`, `Table`, `Tabs`, `Textarea`, `Toggle`,
and `Tooltip`.

Keep their Radix behavior, semantic slots, focus rings, disabled treatment, invalid state,
portal behavior, and keyboard support. Visual changes should happen through semantic tokens
and CVA variants, not through feature-local forks.

### Product components and patterns

| Area | Current modules | Reuse decision |
| --- | ---: | --- |
| App shell/navigation | 63 layout/header/sidebar modules | Keep responsive shell mechanics; redesign hierarchy and visual signature |
| Issues | 22 | Keep selectors, grouped/grid views, detail structure, filter plumbing; rename product copy and re-skin rows |
| Projects | 20 | Keep list/board/timeline and detail composition; make Berry progress/review states distinctive |
| Settings | 18 | Keep form/layout patterns; replace inherited categories with Berry capabilities |
| Data-table filters | 12 TSX modules plus filter core | Keep behavior and generic composition |
| Teams | 9 | Keep member/project primitives; adapt terminology to Berry team and role model |
| Reviews | 7 | Keep diff mechanics; redesign around Berry's review gates and agent/human provenance |
| Cycles | 5 | Keep chart/list foundations only if cycles remain in scope |
| Initiatives | 5 | Defer until the Berry roadmap model is confirmed |
| Inbox | 4 | Keep notification mechanics; reframe as Berry activity/attention queue |
| Members | 4 | Keep identity/profile basics; add agent identity as a peer actor type |
| My issues | 2 | Keep query/view composition; use Berry naming |
| Views | 2 | Keep saved-view mechanics |
| Agent | 1 | Replace inherited chat presentation with Berry run context, controls, provenance, and audit state |

Cross-cutting patterns already present include a command palette, create-issue dialog,
responsive off-canvas sidebar, stacked headers, list/grid/board/timeline views, filter builder,
property selectors, empty/loading states, toasts, charts, diff views, and settings forms.

## Reuse versus re-skin boundary

### Safe to reuse

- MIT-licensed source with its notice retained.
- Radix/shadcn primitive architecture and accessibility behavior.
- Semantic token wiring, dark-mode mechanism, responsive drawer mechanics, form plumbing,
  table/filter logic, resizable panels, charts, and generic loading/empty-state structures.
- Neutral information architecture concepts such as issues, projects, teams, members,
  settings, search, filters, and saved views.

### Must be renamed, redesigned, or validated

- Product name, icon, favicon, page metadata, URLs, sample organizations, people, and copy.
- Any terminology borrowed from another product rather than required by Berry's domain.
- Sidebar grouping/order, compact stacked headers, issue-row composition, keyboard shortcuts,
  command-menu grouping, board cards, property panel, and issue-creation flow as a combined
  visual/interaction signature.
- Neutral monochrome palette plus purple/indigo accents. A final Berry palette must create a
  distinct identity and pass contrast checks in each supported theme.
- Icons and status glyphs where their shape/color pairing makes the interface look like a
  specific third-party product. Use one documented icon family and Berry-specific state
  mappings.
- The generic `agent chat` concept. Berry needs an execution surface with run status,
  permissions, budget, review gate, evidence, logs, pause/cancel controls, and audit history.
- Theme names such as `magic-blue` and `classic-dark`; rename these only after the final
  palette and theme strategy are approved.

Avoiding likeness is a system-level task: changing a logo or accent color alone is
insufficient. At least navigation hierarchy, workspace framing, row/card anatomy, status
language, agent representation, and review interactions should express Berry's model.

## Required states and accessibility contract

Every interactive component or product pattern must specify:

- default, hover, active/pressed, keyboard focus-visible, disabled, loading, error/invalid,
  and success where applicable;
- empty, partial-data, offline/reconnecting, stale, and permission-denied states for
  networked views;
- agent states: queued, running, awaiting input, awaiting review, paused, succeeded, failed,
  cancelled, and budget-limited;
- review states: pending, changes requested, approved, superseded, and merged/released.

Baseline requirements:

- WCAG 2.1 AA contrast: 4.5:1 for normal text, 3:1 for large text and meaningful UI
  graphics; verify semantic pairs in every theme.
- Keep the visible 3 px focus treatment in primitive controls and never communicate state by
  color alone.
- Icon-only controls require an accessible name and tooltip where the action is not obvious.
- Dialogs/sheets need a title and description, focus containment, Escape handling, and focus
  restoration; preserve the Radix implementation.
- Dense desktop targets may be 32–36 px when spacing prevents accidental activation; aim for
  44 px targets on touch layouts.
- Announce asynchronous run/review changes with an appropriate live region without flooding
  screen-reader output. Preserve user control over auto-scroll.
- Charts and diffs require text summaries or equivalent structured data, not color-only
  interpretation.

## Adoption checklist

1. Treat the Brand Manual palette and the semantic state/actor aliases as the baseline for
   all revised surfaces.
2. Centralize layout dimensions, motion durations, and repeated micro typography in tokens.
3. Replace hard-coded palette utilities in feature components with semantic status tokens.
4. Build a primitive/state showcase for light, dark, high-density desktop, and mobile.
5. Redesign the app shell, issue row/card, agent execution surface, and review gate first;
   these establish the strongest Berry identity.
6. Run automated and manual keyboard, screen-reader, reduced-motion, zoom, contrast, and
   responsive checks before calling the system stable.
