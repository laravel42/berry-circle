# Implementation Plan: Authentication and Tenant Isolation

## Overview

This plan turns the approved design into incremental coding tasks for the `@berry/server` Hono/PostgreSQL
backend and the `frontend/` Next.js App Router client. It builds bottom-up in dependency order: the
`050_user_password_credentials` migration and the `node:crypto` scrypt password module first, then the
session-issuance and sign-in/up/out endpoints, then the structural `ScopedDb` isolation mechanism and the
mount rewiring that constructs it, then the RBAC and passwordless-gating wiring, then the frontend auth
screens and onboarding, and finally the fast-check property suite (P1–P14) and the explicit two-workspace
cross-tenant leakage tests.

Stack constraints reflected in every task: the server runs `.ts` directly under
`node --experimental-strip-types` with **no build step** and `erasableSyntaxOnly` (no `enum`, no
`namespace`, no parameter properties), Zod v4 at the boundary, TypeScript strict with no `any`; migrations
are forward-only and immutable and the single new one is `050_user_password_credentials`; tests run under
`node --test`, DB-backed tests self-skip when `BERRY_TEST_DATABASE_URL` is unset, and property tests use
`fast-check` at ≥100 iterations tagged `Feature: auth-and-tenant-isolation, Property N: <text>`. The
`/api/v1` wire contract, error envelope, cursor pagination, `Idempotency-Key` semantics, and serialized
`user`/`workspace`/`member` shapes are preserved. No AWS/DynamoDB/Lambda/Cognito/CDK is introduced.

**Verification commands** (used by the checkpoint tasks):

- Server types: `pnpm typecheck:server`
- Server tests: `pnpm test:server` (with `BERRY_TEST_DATABASE_URL` exported for DB-backed tests; migration
  applied to that database via `pnpm migrate:server`)
- Frontend: `pnpm --filter berry-frontend lint` and `pnpm --filter berry-frontend build:check`
  (`build:check` uses a throwaway dist dir so the working `.next` is not corrupted)

## Tasks

- [ ] 1. Password credential storage: migration and hashing module
  - [x] 1.1 Add the `050_user_password_credentials` forward-only migration
    - Create `server-ts/migrations/050_user_password_credentials.up.sql` adding `password_hash bytea`,
      `password_salt bytea`, `password_updated_at timestamptz` to `users` with `ADD COLUMN IF NOT EXISTS`
    - Add `NOT VALID` check constraints: `users_password_pair_ck`
      (`(password_hash IS NULL) = (password_salt IS NULL)`), `users_password_hash_len_ck`
      (`octet_length = 32` or null), `users_password_salt_len_ck` (`octet_length = 16` or null)
    - Create `server-ts/migrations/050_user_password_credentials.down.sql` dropping the three constraints
      and columns; do not edit any prior migration file
    - Columns are additive and nullable so the migration runs cleanly on an existing database
    - _Requirements: 1.5, 2.1_

  - [x] 1.2 Implement the scrypt password module
    - Create `server-ts/src/auth/password.ts` exporting `SCRYPT_PARAMS` (`N=32768, r=8, p=1, keyLen=32,
      saltBytes=16`, as a `const` object — no `enum`), `StoredPassword { salt: Buffer; hash: Buffer }`,
      `hashPassword(password): Promise<StoredPassword>`, and
      `verifyPassword(password, stored: StoredPassword | null): Promise<boolean>`
    - `hashPassword` draws a fresh 16-byte salt via `randomBytes` and derives with `scrypt`; raise the
      scrypt `maxmem` to accommodate `N=32768`
    - `verifyPassword` always runs a scrypt derivation — including a dummy derivation against a fixed salt
      when `stored` is `null` — and compares with `timingSafeEqual`, so unknown-email and wrong-password
      share one code path and timing
    - _Requirements: 1.4, 1.5, 1.6, 2.1_

  - [x] 1.3 Write property test P10 for password storage
    - **Property 10: Passwords are stored as distinct salted one-way hashes**
    - fast-check ≥100 iters over random 12..128-char passwords (incl. unicode); assert stored hash differs
      from plaintext bytes, two independent hashings differ in salt and hash, `verifyPassword` accepts the
      original and rejects any other; tag `Feature: auth-and-tenant-isolation, Property 10: <text>`
    - Pure crypto (no DB) so this test does not need `BERRY_TEST_DATABASE_URL`
    - **Validates: Requirements 1.5, 2.1**

  - [x] 1.4 Write unit test for constant-time verification structure
    - Assert `verifyPassword(_, null)` performs a derivation and returns `false`, and that verification
      uses `timingSafeEqual` (Requirement 1.6) via the always-derive path
    - _Requirements: 1.6_

- [ ] 2. Session issuance additions and TTL bounds
  - [x] 2.1 Add password and user issuance paths to `SessionService`
    - In `server-ts/src/auth/sessions.ts` add `issuePassword(email, password, meta?)` (loads the user,
      calls `verifyPassword`, funnels into the existing token-generate + insert used by `issueKnownEmail`)
      and `issueForUser(userId, meta?)` for sign-up to issue in the same transaction
    - Reuse the existing 256-bit token generation, SHA-256-only storage, and atomic liveness+`last_used_at`
      stamping; both new paths share one issuance path with passwordless login (Requirement 11.3)
    - _Requirements: 1.1, 2.2, 3.1, 3.3, 11.3_

  - [x] 2.2 Enforce TTL bounds at issue time
    - Tighten `SessionService` to reject a configured TTL outside 300..2,592,000 seconds by throwing a
      typed `ConfigError` (define in `server-ts/src/identity/errors.ts` if absent) at issue time so no
      token is issued; the mount maps it to 500 `INTERNAL` (config error)
    - _Requirements: 3.1, 3.2_

  - [x] 2.3 Write property test P6 for session issuance
    - **Property 6: Session issuance stores only a hash with a bounded expiry**
    - fast-check ≥100 iters; assert stored value equals `sha256hex(rawToken)` and not the raw token,
      decoded token ≥256 bits, `expires_at == issued_at + ttl` within tolerance; DB-backed, self-skip
      without `BERRY_TEST_DATABASE_URL`; tag Property 6
    - **Validates: Requirements 3.1**

  - [x] 2.4 Write property test P7 for the session lifecycle round-trip
    - **Property 7: Session lifecycle round-trip — issue, resolve, revoke, stay rejected**
    - fast-check ≥100 iters over randomized valid op sequences {resolve, expire, revoke, signOut,
      resolveAgain} plus unknown-token sign-out; live resolve returns the user and advances `last_used_at`,
      post-expiry/revocation resolves are 401, sign-out is 204 for known and unknown; DB-backed, self-skip;
      tag Property 7
    - **Validates: Requirements 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

  - [x] 2.5 Write unit test for TTL boundary refusal
    - Assert issuance with an out-of-range TTL throws `ConfigError` and issues no token (Requirement 3.2)
    - _Requirements: 3.2_

- [ ] 3. Auth boundary schemas and sign-in / sign-up / sign-out endpoints
  - [x] 3.1 Add Zod v4 boundary schemas
    - Create `server-ts/src/auth/schemas.ts` with `email` (`trim`, `max(320)`, format regex
      `^[^\s@]+@[^\s@]+\.[^\s@]+$`), `password` (`min(12)`, `max(128)`), and `signInBody` / `signUpBody`
      objects; field-error paths use JSON-Pointer style (`/email`, `/password`) to match `fieldError`
    - _Requirements: 1.8, 2.4, 2.5_

  - [x] 3.2 Implement `POST /api/v1/auth/sign-in`
    - In `server-ts/src/mounts/auth.ts` add the route using the existing bounded-body reader
      (`MAX_LOGIN_BODY_BYTES = 4096`; over-size → 400 before parsing) and shared envelope from
      `server-ts/src/http/{errors,body}.ts`
    - Validate with `signInBody` (→ 422 `VALIDATION_FAILED` naming the field); call
      `SessionService.issuePassword`; success returns `{ token, expiresAt, user }` via the existing
      `serializeUser`; unknown email and wrong password both return the uniform 401 `UNAUTHENTICATED`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 1.8_

  - [x] 3.3 Implement `POST /api/v1/auth/sign-up`
    - Add the route: validate with `signUpBody`; create the user + hash via `hashPassword`; issue with
      `issueForUser` in the same transaction; 201 with `{ token, expiresAt, user }`, never returning the
      hash
    - Honor `Idempotency-Key` via the existing fingerprint pattern used by `WorkspaceRepository.create`
      (identical body replay → original 201; different body → 409 `IDEMPOTENCY_CONFLICT`; malformed key,
      not 16..128 visible-ASCII → 422); duplicate email → 409 `CONFLICT` creating no user
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [x] 3.4 Implement `POST /api/v1/auth/sign-out`
    - Add the route reusing the existing `/logout` behavior: `requireSession`, then `revokeSession(token)`,
      always 204 (including for a token matching no stored session); retain `/logout` as an alias
    - _Requirements: 3.6, 3.7_

  - [x] 3.5 Write property test P9 for sign-in outcome indistinguishability
    - **Property 9: Sign-in credential outcomes are indistinguishable across failure kinds**
    - fast-check ≥100 iters over attempts {correct, wrongPassword, unknownEmail} against registered users;
      correct → 200 with a resolvable token, the two failure kinds → byte-identical 401 envelopes;
      DB-backed, self-skip; tag Property 9
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4**

  - [x] 3.6 Write property test P8 for idempotent creation
    - **Property 8: Idempotent creation is a replay, and a key reuse with a different body is a conflict**
    - fast-check ≥100 iters over sign-up (and workspace create) with {identical body, mutated body, no
      key}; identical → same resource id and unchanged row count, mutated → 409 `IDEMPOTENCY_CONFLICT` and
      unchanged count, no key → fresh resource; DB-backed, self-skip; tag Property 8
    - **Validates: Requirements 2.6, 2.7, 12.4, 12.5, 12.6**

- [x] 4. Checkpoint - credential and session layer
  - Ensure all tests pass, ask the user if questions arise. Run `pnpm typecheck:server` and
    `pnpm test:server` (migration `050` applied to the gated test DB).

- [ ] 5. Structural isolation mechanism — `WorkspaceContext` and `ScopedDb`
  - [x] 5.1 Implement `resolveWorkspaceContext`
    - Create `server-ts/src/identity/workspace-context.ts` with `WorkspaceContext { readonly workspaceId;
      readonly userId; readonly role }` (interface, no `enum`) and
      `resolveWorkspaceContext(sql, userId, workspaceId, required)` that confirms membership against
      `workspace_memberships` before returning; a non-member or absent workspace raises `NotFound` (→ 404),
      indistinguishable; the `workspaceId` is treated only as a lookup key until this returns
    - Reuse `allows(role, permission)` from `server-ts/src/identity/roles.ts` and the membership joins in
      `server-ts/src/identity/workspaces.ts`; map `Forbidden` from membership resolution to `NotFound`
      where distinguishing it would leak membership, keep `Forbidden` for a member lacking a write
      permission
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 8.1, 8.3_

  - [x] 5.2 Implement the `ScopedDb` query surface
    - In the same module add `scopedDb(sql, ctx): ScopedDb` with `ctx`, `list(build)` (injects
      `workspace_id = ctx.workspaceId` or a membership join), `requireResource(table, id)` (resolves a
      resource's stored owning workspace, 404 if not `ctx`'s), and `mutate(required, work)` (runs
      `allows(ctx.role, required)` then the write inside one `sql.begin` transaction that rolls back on any
      throw); no method returns cross-workspace rows
    - _Requirements: 5.3, 6.1, 6.4, 6.5, 7.2, 7.4, 7.6_

  - [x] 5.3 Write property test P5 for server-derived context
    - **Property 5: Workspace context is server-derived and request claims are ignored**
    - fast-check ≥100 iters; inject fake role/`workspaceId` claims into body/header/query differing from
      DB truth; assert `ctx.role` equals the DB membership role and `ctx.workspaceId` equals the resource's
      stored workspace regardless of injected claims; DB-backed, self-skip; tag Property 5
    - **Validates: Requirements 5.1, 5.2, 5.3**

- [ ] 6. Rewire workspace-scoped mounts onto `ScopedDb`
  - [x] 6.1 Migrate the read mounts to session-derived context
    - In `server-ts/src/mounts/workspace-reads.ts` change `search`/`views`/`catalogs` to obtain their
      `ScopedDb` from `resolveWorkspaceContext(sql, user.id, pathId(workspaceId), 'product.read')` so the
      `workspaceId` query parameter is a pure lookup key re-derived against membership before any row is
      returned; a member of no workspace gets an empty collection
    - Preserve the `/api/v1` paths, cursor pagination shape, and serialized shapes unchanged
    - _Requirements: 5.4, 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 6.2 Add the mount wiring that constructs `ScopedDb` and route writes through it
    - Apply the `route.use('/:workspaceId/*', requireSession(sessions))` + context-resolver middleware
      pattern (mechanism B constructing C) so handlers receive a `ScopedDb`; route workspace-scoped
      mutations (via `server-ts/src/core/boards.ts` `authorize`/`authorizeWorkspace`) through
      `ScopedDb.mutate` so authorize + write share one transaction and referenced resources are verified to
      share the workspace
    - Non-member/absent → 404, member lacking write permission → 403; leave stored data unchanged on any
      rejection
    - _Requirements: 5.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.2_

  - [x] 6.3 Write property test P2 for no cross-workspace read
    - **Property 2: No cross-workspace read**
    - fast-check ≥100 iters building randomized worlds (N workspaces, M users, random memberships, K rows);
      assert every returned node's `workspaceId` is in the caller's membership set and a no-membership
      caller gets an empty `nodes` array; DB-backed, self-skip; tag Property 2
    - **Validates: Requirements 5.4, 6.1, 6.4, 6.5**

  - [x] 6.4 Write property test P3 for indistinguishable 404s
    - **Property 3: Cross-workspace and non-existent resources are indistinguishably absent**
    - fast-check ≥100 iters; a read/mutation naming {other-workspace resource, random non-existent uuid}
      yields byte-identical 404 envelopes (status, body, headers) and a pre/post row snapshot is equal;
      DB-backed, self-skip; tag Property 3
    - **Validates: Requirements 5.5, 5.6, 6.2, 6.3, 7.1**

  - [x] 6.5 Write the explicit two-workspace cross-tenant leakage tests
    - Hand-built W1/W2 fixtures asserting the four guarantees: (a) a W1 member listing/searching never sees
      W2 rows; (b) a W1 member GET-ing a W2 resource gets the same 404 as a random uuid; (c) a W1 member
      mutating a W2 resource gets 404 and W2 is unchanged; (d) an unauthenticated caller is rejected before
      any handler runs (sentinel handler never invoked)
    - DB-backed, self-skip without `BERRY_TEST_DATABASE_URL`
    - _Requirements: 6.2, 6.3, 7.1, 4.1_

- [x] 7. Checkpoint - isolation mechanism
  - Ensure all tests pass, ask the user if questions arise. Run `pnpm typecheck:server` and
    `pnpm test:server`.

- [ ] 8. RBAC enforcement, session middleware guarantees, and passwordless gating
  - [x] 8.1 Confirm and wire the RBAC matrix through `ScopedDb.mutate`
    - Ensure `server-ts/src/identity/roles.ts` `allows(role, permission)` returns `false` for any
      unrecognized role, and that `ScopedDb.mutate` calls it before any write, throwing `Forbidden` → 403
      for `product.write`/`settings.write`/`members.manage`/`owners.manage` denials while reads require
      membership only
    - _Requirements: 8.1, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [x] 8.2 Harden `requireSession` guarantees
    - In `server-ts/src/auth/middleware.ts` confirm exactly one `Bearer` credential is admitted, every
      failure (absent/malformed/expired/revoked/unknown/duplicate-header) returns the byte-identical 401
      `UNAUTHENTICATED`, the handler is never invoked on failure, the resolved `User` is attached before
      any `WorkspaceContext` is derived, and a resolution error is caught → 401 (never 500)
    - _Requirements: 3.9, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 8.3 Make the passwordless gate explicit
    - In `server-ts/src/mounts/auth.ts` keep `loginAllowed(config)` as the single gate: `POST
      /api/v1/auth/login` returns 404 `ROUTE_NOT_FOUND` unless `APP_ENV ∈ {development,test}` AND
      `AUTH_ALLOW_PASSWORDLESS_LOGIN` is on; when allowed, issue through the same `SessionService` path as
      password sign-in and refuse an unknown/inactive account with the invalid-credentials envelope; read
      flags from `server-ts/src/config/config.ts`
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x] 8.4 Write property test P1 for uniform unauthenticated rejection
    - **Property 1: Unauthenticated and malformed credentials are uniformly rejected**
    - fast-check ≥100 iters over category ∈ {absent, wrongScheme, empty, whitespace, nonPrintable, tooLong,
      duplicateHeader, unknownButWellFormed}; a sentinel handler is never called and every response equals
      the first category's response byte-for-byte; DB-backed for the unknown-token case, self-skip; tag
      Property 1
    - **Validates: Requirements 3.9, 4.1, 4.2, 4.3, 4.4, 8.2**

  - [x] 8.5 Write property test P4 for the role-permission matrix
    - **Property 4: Authorization grants exactly the role-permission matrix**
    - fast-check ≥100 iters over `ROLES ∪ {corrupt}` × `PERMISSIONS` paired with a mutation requiring that
      permission; decision equals `allows(role, permission)`, denial yields `FORBIDDEN` with an equal
      pre/post snapshot; DB-backed, self-skip; tag Property 4
    - **Validates: Requirements 7.2, 7.3, 8.1, 8.3, 8.4, 8.5, 8.6, 8.7**

  - [x] 8.6 Write property test P13 for the passwordless availability truth table
    - **Property 13: Passwordless login availability is exactly the environment-and-flag truth table**
    - fast-check ≥100 iters over environment ∈ {development, test, production, staging, random} × flag ∈
      {on, off} × target ∈ {existing, unknown}; available iff `env ∈ {development,test} ∧ flag`, else 404
      `ROUTE_NOT_FOUND`; available + unknown target → invalid-credentials envelope and no session row;
      DB-backed, self-skip; tag Property 13
    - **Validates: Requirements 11.1, 11.2, 11.4**

  - [x] 8.7 Write unit tests for middleware fault injection and passwordless issuance sameness
    - Resolver-throws → 401 (Requirement 4.7); context unreachable without a resolved user (Requirement
      4.6); passwordless issuance uses the same `SessionService` path as password sign-in (Requirement
      11.3)
    - _Requirements: 4.6, 4.7, 11.3_

- [ ] 9. Onboarding server paths (selection and invitations)
  - [x] 9.1 Wire workspace selection over the existing `last_workspace_id`
    - Ensure `POST /api/v1/workspaces` records the creator as an `owner` membership and sets
      `users.last_workspace_id` (migration 004, no new migration), and the workspace-select endpoint
      records selection only for a workspace the user belongs to, returning 404 `NOT_FOUND` and leaving
      selection unchanged otherwise; reuse `WorkspaceRepository.create`/`select` in
      `server-ts/src/identity/workspaces.ts`
    - _Requirements: 10.1, 10.3, 10.4, 10.5_

  - [x] 9.2 Confirm single-use invitation acceptance
    - Ensure `POST /api/v1/invitations/:id/accept` uses `SecretsRepository.acceptInvitation`
      (`server-ts/src/identity/secrets.ts`) marking the invitation consumed inside a `FOR UPDATE`
      transaction, creating at most one membership with the invitation's role, and rejecting
      expired/revoked/already-accepted/wrong-identity presentations with the error envelope (no new
      migration; `workspace_invitations` exists at migration 004)
    - _Requirements: 10.6, 10.7, 10.8_

  - [x] 9.3 Write property test P12 for workspace selection
    - **Property 12: Workspace selection follows previous-if-valid-else-earliest and select requires
      membership**
    - fast-check ≥100 iters over memberships with random `joined_at`, stored selection ∈ {valid, stale,
      null}, select targets ∈ {member, non-member}; chosen equals the pure rule, member-select updates,
      non-member-select → 404 and unchanged, create → owner membership present and selection == new id;
      DB-backed, self-skip; tag Property 12
    - **Validates: Requirements 10.1, 10.3, 10.4, 10.5**

  - [x] 9.4 Write property test P11 for invitation single-use
    - **Property 11: Invitation acceptance is single-use and idempotent for the invitee**
    - fast-check ≥100 iters over invitation state ∈ {valid, expired, revoked, alreadyAccepted,
      wrongIdentity} with possibly-repeated accepts; valid → membership count exactly 1, invalid → rejected
      and count 0; DB-backed, self-skip; tag Property 11
    - **Validates: Requirements 10.6, 10.7, 10.8**

- [x] 10. Checkpoint - server complete
  - Ensure all tests pass, ask the user if questions arise. Run `pnpm typecheck:server` and
    `pnpm test:server`, plus property test P14 below once wired.

  - [x] 10.1 Write property test P14 for wire-contract preservation
    - **Property 14: The wire contract shapes are preserved**
    - fast-check ≥100 iters; failure bodies match the `{ error: { code, message, requestId, details } }`
      envelope, `endCursor === null` exactly when `hasNextPage === false`, serialized `user`/`workspace`/
      `member` key sets equal the fixed constants and contain no `password*` key; tag Property 14
    - **Validates: Requirements 12.2, 12.3, 12.7**

- [ ] 11. Frontend Session_Client confirmation
  - [x] 11.1 Confirm the token holder never uses `NEXT_PUBLIC_`
    - Verify `frontend/lib/session.ts` keeps the raw token in an in-memory closure plus tab-scoped
      `sessionStorage` (`createMemoryApiSession`, `persistSessionToken`, `clearSessionToken`) and
      `frontend/lib/api.ts` `apiFetch` attaches `Authorization: Bearer <token>`; the token is never placed
      in a URL, build config, or a `NEXT_PUBLIC_` variable, and credentials go only to the Berry API via
      same-origin rewrites
    - _Requirements: 9.3, 9.6_

- [ ] 12. Frontend auth screens
  - [x] 12.1 Build the `/sign-in` screen
    - Create `frontend/app/sign-in/page.tsx` with an email + password form calling
      `POST /api/v1/auth/sign-in` via `apiFetch`; client-side required-field validation blocks empty
      submits with field-level errors; on 401 show a neutral credential error that does not reveal whether
      the email is registered and keep the entered email; on network/non-401 show a "could not complete"
      error, establish no session, stay on screen; on success persist the token via `frontend/lib/session.ts`
      and route into the workspace within 2s; follow Prettier (3-space, single-quote) + ESLint
    - _Requirements: 9.1, 9.2, 9.5, 9.8, 9.9_

  - [x] 12.2 Build the `/sign-up` screen
    - Create `frontend/app/sign-up/page.tsx` with email + password (+ confirm) calling
      `POST /api/v1/auth/sign-up`; on success behave like sign-in and enter onboarding
    - _Requirements: 9.2, 10.2_

  - [x] 12.3 Add the sign-out control
    - Add a sign-out control calling `POST /api/v1/auth/sign-out`; on success clear both the in-memory
      holder and `sessionStorage` and return to `/sign-in`; if it does not succeed within 5s, clear
      locally, return to `/sign-in`, and show a "session ended locally" notice
    - _Requirements: 9.4, 9.10_

  - [x] 12.4 Remove auto-login and add the protected-route guard
    - Change `frontend/store/session-store.ts` hydrate path so that where `Passwordless_Login` is disabled
      it does not auto-establish a session (remove the `AUTO_LOGIN_EMAIL` auto-login) and requires an
      explicit sign-in before any protected route renders; the guard presents `/sign-in` for an anonymous
      visitor; update `frontend/lib/auth.ts` as needed
    - _Requirements: 9.1, 9.7_

  - [ ] 12.5 Write frontend component/integration tests for the auth screens
    - Faked API: anonymous → sign-in; valid credentials → token in memory + `sessionStorage` and routed
      within budget; 401 → neutral error with email retained; network/non-401 → error, no session, stay on
      screen; sign-out success and 5s-timeout paths; passwordless-off → no auto-session; assert token never
      appears in a URL or `NEXT_PUBLIC_` variable
    - _Requirements: 9.1, 9.2, 9.4, 9.5, 9.7, 9.8, 9.9, 9.10_

- [ ] 13. Frontend onboarding
  - [x] 13.1 Build the onboarding flow
    - Create `frontend/app/onboarding/` screens: after auth call `GET /api/v1/me/bootstrap`; with ≥1
      membership route into the selected workspace (previously selected if valid, else earliest-joined)
      within 2s without forcing creation; with no membership show a create-or-join step — create calls
      `POST /api/v1/workspaces`, join calls `POST /api/v1/invitations/:id/accept`, select calls the
      workspace-select endpoint; use `frontend/lib/api.ts` and `frontend/store/session-store.ts`
    - _Requirements: 10.1, 10.2, 10.4, 10.5, 10.6_

  - [ ] 13.2 Write frontend integration tests for onboarding routing
    - Faked API: ≥1 membership → routed into selected workspace within budget without a creation step; no
      membership → create-or-join step shown before any workspace content
    - _Requirements: 10.1, 10.2_

- [ ] 14. Final checkpoint - full feature
  - Ensure all tests pass, ask the user if questions arise. Server: `pnpm typecheck:server` and
    `pnpm test:server` (migration `050` applied to the gated test DB). Frontend:
    `pnpm --filter berry-frontend lint` and `pnpm --filter berry-frontend build:check`.

## Notes

- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster MVP; the required
  (unmarked) task set delivers a complete, verifiable feature.
- Each task references specific requirement clauses and/or design Property numbers for traceability.
- Property-based tests P1–P14 use `fast-check` at ≥100 iterations, are tagged
  `Feature: auth-and-tenant-isolation, Property N: <text>`, and self-skip when `BERRY_TEST_DATABASE_URL`
  is unset (DB-backed ones); P10 is pure crypto and needs no database.
- The explicit two-workspace cross-tenant leakage tests (6.5) complement the isolation properties (P2, P3,
  P4, P5) so the four security guarantees are guarded even if a generator never hits the adversarial case.
- The only new migration is `050_user_password_credentials`; `users.last_workspace_id` and
  `workspace_invitations` already exist at migration 004 and need no new migration.
- No `enum`/`namespace`/parameter-properties in server code (`erasableSyntaxOnly`); no `any`; no build
  step; Zod v4 at the boundary; the `/api/v1` contract, error envelope, cursor pagination, idempotency,
  and serialized shapes are preserved.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4", "2.1", "2.2"] },
    { "id": 2, "tasks": ["2.3", "2.4", "2.5", "3.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4"] },
    { "id": 4, "tasks": ["3.5", "3.6", "5.1"] },
    { "id": 5, "tasks": ["5.2", "8.2", "8.3"] },
    { "id": 6, "tasks": ["5.3", "6.1", "6.2", "8.1"] },
    { "id": 7, "tasks": ["6.3", "6.4", "6.5", "8.4", "8.5", "8.6", "8.7"] },
    { "id": 8, "tasks": ["9.1", "9.2"] },
    { "id": 9, "tasks": ["9.3", "9.4", "10.1"] },
    { "id": 10, "tasks": ["11.1"] },
    { "id": 11, "tasks": ["12.1", "12.2", "12.3", "12.4", "13.1"] },
    { "id": 12, "tasks": ["12.5", "13.2"] }
  ]
}
```
