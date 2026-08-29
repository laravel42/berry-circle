# Berry — Product Overview for Design

*A design-facing brief. Engineering sources of truth live in `docs/product-brief.md` and `docs/design-system.md`.*

---

## What Berry is

**Berry is a cloud workspace where humans and AI coding agents plan, execute, and review work together.**

It is issue and project management, collaboration, agent configuration, and legible run evidence in one browser experience. An assignee can be a **person or an agent**; the same issue, status, comment, and review primitives drive both.

Berry is **not** an agent runtime. It is the product and persistence layer on top of **Google ADK** (agent execution substrate). ADK owns execution, sandboxing, scheduling, tools, and model plumbing. Berry owns workspaces, issues, collaboration, review decisions, and the **issue-correlated run ledger**. Browsers call Berry only — never the execution substrate directly.

Berry is delivered as **SaaS**: sign up, create or join workspaces, and work in the browser. Berry runs the product API, persistence, and managed agent infrastructure. Billing, subscriptions, and workspace administration are first-class parts of the experience, not optional add-ons.

---

## Who it's for

**Primary:** Software teams already using coding agents who hit the coordination ceiling of running them from individual terminals.

- Agent work is invisible — no shared view of progress, cost, or review state.
- Hand-offs are manual — humans copy agent output into PRs and paste links back into trackers.
- There is no gate — agent output lands wherever the agent left it; review is informal.

**Secondary:** Engineering leads and operators who want agent throughput with normal team accountability: audit trail, budget visibility, workspace controls, and a **human gate before release**.

---

## Philosophy

### 1. The release gate is always human

Agents can plan, implement, and stage work autonomously. Nothing ships without a person accepting it. **Review is a first-class state**, not a comment that says "LGTM." When an agent delivers, the issue moves to *in review* with evidence attached: diff, logs, cost, audit hash.

### 2. One board, two actor types

Humans and agents are peers in the product model. Assignment, status transitions, comments, and review all use the same primitives. The UI must treat **human work, agent work, reviews, and run state as equal first-class visual semantics** — not bolt-on badges on a human-only tracker.

### 3. Legible execution, not magic chat

Berry is not a generic chat window with a logo. Agent work surfaces as **runs correlated to issues**: queued, running, awaiting input, awaiting review, succeeded, failed, cancelled, budget-limited. Users see steps, events, usage, and cost tied back to the issue they care about.

### 4. SaaS first

Berry is a hosted product: accounts, workspaces, billing, and agent runtime are operated by Berry. Design for the full signup-to-workflow journey — onboarding, workspace creation, invitations, plan limits, and account settings — as core surfaces, not admin afterthoughts. Trust, uptime, and data-handling expectations match a team tool people rely on daily.

### 5. Distinct identity, familiar ergonomics

Berry inherits dense operations-workspace patterns (boards, filters, drawers, command palette) from its Circle frontend lineage, but **must not read as a clone of another issue tracker**. Identity comes from palette, type hierarchy, navigation grouping, terminology, and how agent/review states are expressed — not from copying another product's visual signature.

### 6. Dense, not cramped

Information density is appropriate for people managing many issues and runs. Compact 24–28 px controls exist for tables and toolbars; **36 px is the default for primary desktop actions**. Hierarchy comes from size, tone, and spacing — not from stacking font weights.

---

## Core product motion

```
Issue → Assign (human or agent) → Work on issue → In review → Done
```

1. **Issue** — Work starts as an issue with project, properties, status, priority, relationships, and assignee.
2. **Assign to an agent** — Berry mints its own run record, runs the agent server-side, and correlates steps, events, usage, and cost to that run and issue.
3. **Work on the issue** — The agent posts progress as issue comments; status transitions as work moves. A human can interject, redirect, or take over at any time.
4. **Review gate** — Delivered work enters *in review*. Human acceptance is required before *done*.
5. **Done & audit** — Acceptance and workflow history are durable Berry records. Run artifacts link as execution evidence; they do not replace Berry's run ledger.

Status flow: `backlog → todo → in_progress → in_review → done` (with `cancelled` available).

---

## Feature map

Features are grouped the way the shell rail organizes them. Some surfaces are live with real API data; others are scaffolded UI awaiting backend parity. Design should treat all listed areas as **in-scope product intent**, not throwaway mocks.

### Personal (top of rail)

| Feature | Purpose |
| --- | --- |
| **Inbox / notifications** | Workspace landing; unread activity, mentions, and actionable items. Bell + drawer pattern replaces a dedicated inbox page in the current shell. |
| **Chat** | Workspace-scoped conversation with agents and teammates. |
| **Meetings** | Scheduled or live collaboration (scaffolded in navigation). |

### Work

| Feature | Purpose |
| --- | --- |
| **Tasks (My Issues)** | Personal queue with tabs (All, Assigned, Created, …), filters, and saved views. Default entry for "what should I do next?" |
| **Reviews** | PR-style code review inside the app — "For you" and "Created" lists, diff view, review guide, detail drawer. Tied to the human review gate. |
| **Goals** | Outcome-oriented planning; links to plans and goal detail. |
| **Analytics** | Workspace metrics and operational visibility (navigation placeholder). |
| **Projects** | Project list, overview, issue board, activity timeline, create-project flow. |

### Issues & boards (reachable from projects, views, command palette)

- **Kanban / grouped board** — Column-based issue board with configurable width and grouping.
- **Issue detail** — Properties, description (plain text), comments, assignee (user or agent), related runs, auto-review history.
- **Filters & saved views** — Data-table filter builder, view pinning, bulk operations.
- **Create issue** — Modal/dialog flow with command-palette shortcut; same pattern for create plan and create project.

### Automate

| Feature | Purpose |
| --- | --- |
| **Runs** | The ledger of an agent working a task: commands, output, artifacts, per-run detail. |
| **Approvals** | The human decisions that gate a plan, a task's start, or an action an agent takes outside Berry. |

Berry has no rules engine, and that is deliberate. A trigger-and-steps builder
asks a person to keep a rule in agreement with work that lives somewhere else;
a condition that must be respected belongs in the task's description, where
the agent doing the work will read it.

### Manage

| Feature | Purpose |
| --- | --- |
| **Agents** | Agent roster, configuration, builder entry points, per-agent detail. |

### Settings & workspace administration

Profile, preferences, notifications, issue labels/templates, integrations, AI settings, code & reviews preferences, security, workspace members, and domain-specific admin (SLAs, releases, initiatives, documents, etc.). Settings replace the rail when active — same pattern as the legacy sidebar.

### Cross-cutting UX

- **Multi-workspace shell** — Workspace switcher on brand row; browser-style tab strip for open routes; collapsible left rail (~218 px).
- **Command palette** — Global search, navigation, and create actions.
- **Detail drawers** — Issue, project, review and agent detail as panels over the workspace (max ~1024 px); list context stays visible behind.
- **Keyboard shortcuts** — Configurable; create-issue and navigation shortcuts are first-class.
- **Customize sidebar** — Pin, hide, and reorder rail items by section.

### Planned / phased (in parity contract, not all built)

Agent builder (AI-assisted and manual), skills catalog, squads, usage/cost dashboards, autopilot hardening, GitHub/VCS integrations, channel bindings (Slack, Telegram, etc.), MCP configuration, plugins, and four-locale support (`en`, `zh-Hans`, `ja`, `ko`).