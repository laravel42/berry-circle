# Product

- 2026-08-28 — **Supersedes the 2026-08-22 entries below.** Berry runs agents itself, in-process on the Google Agent Development Kit (ADR-0008). It no longer consumes an external execution substrate.
- 2026-08-22 — Berry is a self-hosted web workspace where humans and agents share one board; it consumes an external runtime and does not rebuild execution (`docs/product-brief.md`, `README.md`).
- 2026-08-22 — Core motion: issue → assign (human or agent) → work on the issue → human review gate → done. Release gate is always human.
- 2026-08-22 — Release 1 is web-only: no multi-tenant control plane, no changes to the external runtime's kernel. Audience is 3–20 person teams already using coding agents.
- 2026-08-22 — Milestones: M0 Foundation (done) → M1 runtime proof (in progress) → M2 Gateway → M3 Frontend wiring → M4 execution loop → M5 product layer → M6 hardening. First tagged release is M6.
- 2026-08-22 — Phase 1 is gateway + wired frontend; Phase 2 is crew setup, run replay, enforced review gates, roles/budgets.
- 2026-09-01 — Projects are the authored container and where planning starts: giving a project the **AI workflow** lead is what asks Berry to plan it, and AutoGate is offered only beside that lead. Goals became a read-only surface — a goal is the group of tasks one plan produced, inside its project, and its status is read off those tasks (ADR-0010, proposed; the migration behind it was reverted, see `server.md`).
