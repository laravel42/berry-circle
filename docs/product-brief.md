# Berry — Product Brief

*Expanded web direction · approved 2026-08-22*

## What Berry is

Berry is a multi-workspace web product where humans and AI coding agents plan,
execute, and review work together. It combines issue and project management,
collaboration, agent configuration, automation, integrations, and legible run
evidence in one browser experience. An assignee can be a person or an agent,
and the same assignment, status, comment, and review primitives drive both.

Berry runs agents itself. Since [ADR-0008](adr/0008-adk-agent-runtime.md) an
agent is a row and a run is executed in-process on the Google Agent Development
Kit, with one model client pointed at OpenRouter. Berry does not reimplement
sandboxing or provider plumbing beyond that seam.

Berry owns the product motion and its durable facts: users and workspaces,
memberships, issues and projects, collaboration, configuration, review
decisions, and the issue-correlated run ledger. Browsers call Berry only; they
never receive a provider credential or call a model provider directly.

## Who it's for

**Primary: software teams that already use coding agents** and are hitting the
coordination ceiling of running them from individual terminals. Their pain:

- Agent work is invisible. Nobody knows what an agent is doing, what it cost, or whether its output was reviewed.
- Hand-offs are manual. A human prompts an agent, copies the result into a PR, and pastes links back into the tracker.
- There is no gate. Agent output lands wherever the agent left it; review is a vibe, not a state.

**Secondary: engineering leads and operators** who want agent throughput with
the accountability of a normal team process: an audit trail, budget visibility,
workspace-level controls, and a human gate before release.

Self-hosting is the complete default product, not a reduced hosted client. One
deployment may contain multiple workspaces. Optional Berry-hosted/cloud modules
may be added for billing, subscriptions, or managed runtime services, but they
are disabled by default and core self-hosted behavior cannot depend on them.

## The product motion: issue → agent → review

Berry's core loop mirrors how a team already works, extended to agents:

1. **Issue.** Work starts as an issue with a project, properties, status,
   priority, relationships, and a human or agent assignee.
2. **Assign to an agent.** Berry creates its own run record, then runs the agent
   server-side with the approved context. Steps, events, usage, and cost are
   correlated back to that Berry run and issue.
3. **Work happens on the issue.** The agent posts progress and results as issue comments; status transitions happen as the work moves. A human can interject in the thread, redirect, or take over.
4. **Review gate.** When the agent delivers, the issue moves to *in review*. Nothing ships without a human accepting it. Review is a first-class state with the run's evidence (diff, logs, cost, audit hash) attached — not a comment saying "LGTM".
5. **Done & audit.** Human acceptance and Berry workflow history are durable
   product records. Run artifacts are linked as execution evidence; they do not
   replace Berry's run ledger.

The inner loop (issue → agent run → in review) is autonomous up to staging; the **release gate is always human**.

## Approved web direction

The completion contract is the
[pinned Multica web parity matrix](parity/multica-web.md). Every discovered
source feature is classified as required core, optional hosted, replaced by
Berry's own runtime, or explicitly excluded. Berry delivers the web surface in
phases:

1. **Contracts and server foundation.** Establish provenance, the `server-ts/`
   package, shared API compatibility fixtures, storage boundaries, and
   fail-closed module gates.
2. **Identity and multi-workspace shell.** Authentication, onboarding,
   workspace switching, members, invitations, navigation, search, shortcuts,
   and settings foundations.
3. **Work management and collaboration.** Full issue modes, tables, filters,
   saved views, detail and bulk workflows, comments, attachments, projects,
   inbox, and notifications.
4. **Agent product layer.** Agent and builder surfaces, skills, MCP, squads,
   chat, run evidence, and usage.
5. **Automation, integrations, and language parity.** Autopilots, VCS/GitHub,
   channel integrations, plugins/Composio, and `en`, `zh-Hans`, `ja`, and `ko`.
6. **Optional hosted surfaces and public site.** Hosted billing,
   subscriptions, managed cloud modules, and marketing pages, all isolated from
   self-hosted core.

The browser-facing server is the TypeScript service selected by
[ADR-0009](adr/0009-typescript-product-server.md): Hono for routing, postgres.js
over PostgreSQL, Valkey for cache and ephemeral coordination, and SSE for live
product behavior. The public interface remains Berry's `/api/v1` contract with
its error envelope, cursor, idempotency, authentication, and `camelCase` rules.

Desktop and mobile clients are not part of web parity. Multica's CLI, daemon,
daemon WebSocket, local launchers, provider adapters, and filesystem execution
are not ported; Berry's own runtime replaces those execution responsibilities.
Placeholder or temporary development surfaces are excluded explicitly in the
matrix.

## Historical scope and migration

The original Release 1 brief scoped Berry to a narrow, single-workspace board
and agent-review loop implemented by a compatibility gateway and a partially
wired Circle frontend. That was the accepted implementation scope for the M0/M1
foundation work; it is retained in Git history.

This expanded direction supersedes that Release 1 implementation scope. The
change in server implementation does not relax the human review gate.

## Licensing posture

- **Berry's own code** is developed against permissive licenses only. Every dependency must be MIT / Apache-2.0 (or equivalently permissive); no copyleft in the shipped product.
- **The agent runtime** is `@google/adk`, Apache-2.0. Berry retains its notices.
- **Circle** (frontend template) is MIT; its notice is retained in the frontend.
- **Multica:** the rights owner authorized reuse and relicensing of approved
  first-party Go product/control-plane material at a pinned commit. Every
  adapted path still requires the dependency and provenance audit in
  [the reuse record](provenance/multica-server-reuse.md). Legacy UI code and
  branding are not imported.
- Berry's API uses conventional resource-oriented JSON and pagination. No
  third-party product schema, brand, or marks become Berry product identity.
- Berry's own license and third-party notice file live in the repository root and are kept current as dependencies are added.

---

*Sources: Berry's original Release 1 brief; the pinned Multica baseline in the
provenance record; Circle (github.com/ln-dev7/circle).*
