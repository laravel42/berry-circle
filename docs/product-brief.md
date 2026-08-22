# Berry — Product Brief

*Release 1 · M0 Foundation · BERR-9*

## What Berry is

Berry is a team workspace where humans and AI coding agents share one board. It looks and feels like a modern issue tracker — issues, projects, cycles, assignees, statuses, review gates — but an assignee can be a person *or* an agent, and the same workflow primitives (assignment, status transitions, comments, review) drive both.

Berry does not build its own agent runtime. It is a product layer on top of **OpenFang**, an MIT-licensed agent execution substrate (https://github.com/RightNow-AI/openfang). OpenFang provides the agent kernel — WASM-sandboxed tool execution, RBAC, a scheduler, budget tracking, a Merkle audit trail, and bindings for 27 LLM providers including local models (Qwen via vLLM) — exposed through a 140+ endpoint REST/WS/SSE API plus an OpenAI-compatible API on `localhost:4200`. Berry consumes that API; it never re-implements execution, sandboxing, or provider plumbing.

What OpenFang does not ship — and what Berry exists to provide — is the *product motion*: an issue tracker, a board, team collaboration, and a review-gate model that make agent work legible, assignable, and shippable by a team.

## Who it's for

**Primary: small software teams (3–20 people) that already use coding agents** and are hitting the coordination ceiling of running them from individual terminals. Their pain:

- Agent work is invisible. Nobody knows what an agent is doing, what it cost, or whether its output was reviewed.
- Hand-offs are manual. A human prompts an agent, copies the result into a PR, and pastes links back into the tracker.
- There is no gate. Agent output lands wherever the agent left it; review is a vibe, not a state.

**Secondary: engineering leads and founders** who want the throughput of agent labor with the accountability of a normal team process — an audit trail, budget visibility, and a human gate before release.

Berry is not for teams looking for a hosted autonomous-dev service, and Release 1 is not a multi-tenant SaaS: it is a self-hosted web app a team runs next to its own OpenFang instance.

## The product motion: issue → agent → review

Berry's core loop mirrors how a team already works, extended to agents:

1. **Issue.** Work starts as an issue on the board — title, description, priority, project, assignee. The board is Linear-shaped: list/board views, statuses (backlog → todo → in progress → in review → done), cycles, projects.
2. **Assign to an agent.** Assigning an issue to an agent (or moving it into an agent-owned stage) dispatches a run through the gateway to OpenFang. The agent gets the issue context, the bound repository, and the workspace conventions. Its run — steps, tool calls, tokens, cost — is tracked against the issue.
3. **Work happens on the issue.** The agent posts progress and results as issue comments; status transitions happen as the work moves. A human can interject in the thread, redirect, or take over.
4. **Review gate.** When the agent delivers, the issue moves to *in review*. Nothing ships without a human accepting it. Review is a first-class state with the run's evidence (diff, logs, cost, audit hash) attached — not a comment saying "LGTM".
5. **Done & audit.** Acceptance is recorded by a human. Every step — dispatch, tool calls, transitions, approvals — lands in OpenFang's Merkle audit trail, so the team can answer "who did what, when, and at what cost" for any issue.

The inner loop (issue → agent run → in review) is autonomous up to staging; the **release gate is always human**.

## Release 1 scope

Release 1 is a **web application only**, delivered in two phases:

**Phase 1 — Gateway + wired frontend**
- **Gateway (BFF):** a Bun/Hono TypeScript service that adapts OpenFang's API into a Linear-shaped product API (resource shapes, cursor pagination — as *convention*, not copied schema). Native fetch, Web Streams/SSE for live updates, Zod for validation, Valkey for cache/state, PostgreSQL for product data, OpenTelemetry + Pino for observability. Ships as Docker containers.
- **Frontend:** the Circle template (MIT, Next.js + shadcn/ui + Tailwind) wired to the gateway — the board, issue views, and run status against the real API.

**Phase 2 — Product layer**
- Agent-crew setup UI (define the team's agents, their capabilities, and access).
- Run replay: step through what an agent did on an issue.
- Review gates as enforced workflow, not convention.
- Team/role semantics (who can dispatch agents, who can approve releases, budgets per team/project).
- Unified endpoint catalog with DTO relay.

**Explicitly out of scope for Release 1:** the internal central server tier (multi-tenant control plane), mobile/native clients, and any modification to OpenFang's kernel.

### Milestones

M0 Foundation & KB → M1 OpenFang integration proof → M2 Gateway → M3 Frontend wiring → M4 Agent execution loop → M5 Product layer → M6 Hardening & release. Documentation and reporting are continuous throughout.

## Licensing posture

- **Berry's own code** is developed against permissive licenses only. Every dependency must be MIT / Apache-2.0 (or equivalently permissive); no copyleft in the shipped product.
- **OpenFang** is MIT. Berry consumes it as an external service over its API and retains its MIT notices. Berry never uses the "OpenFang" name or marks in its own branding.
- **Circle** (frontend template) is MIT; its notice is retained in the frontend.
- Berry's API follows the *conventions* of Linear's public API (resource shapes, pagination style) as design convention only — no schema, code, brand, or marks are copied. The name "Linear" is never used in product, code identifiers, or docs.
- Berry's own license and third-party notice file live in the repository root and are kept current as dependencies are added.

---

*Sources: project description (Berry — Web App, Release 1), OpenFang repository (github.com/RightNow-AI/openfang), Circle template (github.com/ln-dev7/circle).*
