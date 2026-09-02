# Conventions

- 2026-08-28 — **Supersedes the workspace-specific entries below.** Gates are `pnpm typecheck:server` + `pnpm test:server` and frontend `pnpm lint` + `pnpm build`. Commit scopes are `server-ts` and `frontend`. Backend PR Adversary reviews the server.
- 2026-08-22 — Coding playbook is `docs/coding-playbook.md` (BERR-13). TypeScript `strict`, no `any`, path aliases, Zod at boundaries, central Hono errors.
- 2026-08-22 — Commits: `type(scope): imperative summary (BERR-NN)`. Agent branches `agent/<name>/<hash>`; hand branches `fix/berr-NN-short-slug`. One issue per PR.
- 2026-08-22 — Reviewers: Sentinel (frontend), Backend PR Adversary (gateway). Zero blocking findings merges; re-review is full-PR. Skip `in_review` after a clean review this cycle.
- 2026-08-22 — Done: gateway `typecheck` + `lint` + `test`; frontend `lint` + `build` + manual view check. Changelog: Keep a Changelog in `CHANGELOG.md` (`docs/changelog-process.md`).
- 2026-08-22 — Five gateway review PRs landed squash-merge after BPA-style comments: #21 agent runtime, #18 session auth, #19 Valkey, #20 SSE, #23 issues/comments.
- 2026-08-22 — Local `main` fast-forwarded to `64b925f`; leftover runtime/SSE WIP discarded (already on origin). Committed agent context as `e6f3961`.
- 2026-08-22 — Next work is repo-derived (no Linear/GitHub issues): boards CRUD (BERR-11), session auth on product routes (BERR-24), frontend board wiring (BERR-29). Three isolated worktree agents launched.
