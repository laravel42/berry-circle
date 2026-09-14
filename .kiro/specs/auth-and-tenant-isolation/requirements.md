# Requirements Document

## Introduction

Berry is a self-hosted, multi-workspace product where humans and AI coding agents plan, execute, and
review work together. A **workspace is the tenant**: boards, issues, comments, labels, saved views,
members, and invitations all belong to exactly one workspace, and no member of one workspace may read
or write another's data.

Today two gaps undermine that promise:

1. **There is no real sign-in.** The only login path, `POST /api/v1/auth/login`, accepts a *known
   email with no password* and is gated to `development`/`test` environments. The Next.js frontend
   auto-logs-in as `prototype@berry.test` (`AUTO_LOGIN_EMAIL`), and `/login` merely redirects into the
   app. There is no sign-up, no credential verification, no user-driven sign-out surface, and no real
   onboarding into a workspace. Anyone who reaches the frontend is signed in as the prototype user.

2. **Workspace isolation is correct today only by convention.** The data layer already scopes every
   workspace query by joining `workspace_memberships` (see `WorkspaceRepository`, `BoardRepository`),
   and returns an identical "not found" for a workspace the caller does not belong to versus one that
   does not exist. Authorization is centralized in `boards.authorize` / `boards.authorizeWorkspace`
   against the `roles.ts` permission matrix. But nothing *structurally forces* a workspace-scoped
   handler to perform that check — correctness rests on each handler remembering to call it — and read
   mounts such as `search`/`views`/`catalogs` take the target `workspaceId` from a client-supplied
   query parameter, re-authorized server-side but never re-derived from the session's own membership.

This feature delivers **real authentication screens** in the frontend and **enforced, testable
multi-tenant (workspace) isolation** at the request boundary and data layer, preserving the existing
`/api/v1` wire contract, the opaque-session-token mechanism, the stable error envelope, cursor
pagination, and `Idempotency-Key` semantics.

The SaaS Builder power is used only as a *pattern* reference (tenant-per-workspace, session-derived
tenant context, RBAC at the boundary, no-cross-tenant-leakage as a first-class property). Its AWS
infrastructure (DynamoDB, Lambda, API Gateway, Cognito, CDK) is explicitly out of scope: Berry's stack
is a TypeScript Hono server over PostgreSQL 16 with a Next.js App Router frontend.

## Glossary

- **Auth_Service**: The server-side component that issues, validates, expires, and revokes credentials.
  Realized by `SessionService` in `server-ts/src/auth/sessions.ts`.
- **Session_Middleware**: The request-boundary component that requires a valid credential on protected
  routes. Realized by `requireSession` in `server-ts/src/auth/middleware.ts`.
- **Session_Token**: An opaque bearer token issued at sign-in. Only its SHA-256 hash is stored; the raw
  value is returned once and sent as `Authorization: Bearer <token>` thereafter.
- **PAT**: A personal access token prefixed `berry_pat_`, resolved by the same middleware as an
  alternative credential. In scope only insofar as auth screens must not weaken it.
- **Workspace**: The tenant. A row in `workspaces` to which product data belongs.
- **Membership**: A row in `workspace_memberships` binding a User to a Workspace with a Role. Membership
  is the security boundary for tenant isolation.
- **Role**: One of `owner`, `admin`, `member`, `viewer` (`server-ts/src/identity/roles.ts`), mapped to a
  fixed permission set.
- **Permission**: A capability such as `product.read`, `product.write`, `settings.write`,
  `members.manage`, checked by `allows(role, permission)`.
- **Authorizer**: The centralized check that resolves the caller's Membership for a Workspace (directly
  or via a resource) and enforces a required Permission. Realized by `boards.authorize` /
  `boards.authorizeWorkspace`.
- **Workspace_Context**: The Workspace a request operates within, together with the caller's Role in it,
  derived server-side from the authenticated session's Membership.
- **Auth_UI**: The Next.js App Router screens for sign-in, sign-up, sign-out, and workspace onboarding
  under `frontend/`.
- **Session_Client**: The frontend token holder (`frontend/lib/session.ts`, `frontend/lib/api.ts`) that
  keeps the raw token in a closure and `sessionStorage`, and attaches it as a bearer.
- **Error_Envelope**: The stable response body `{ "error": { "code": "SCREAMING_SNAKE_CASE",
  "message": "..." } }` used on every failure.
- **Passwordless_Login**: The existing known-email, no-password login path gated to non-production
  environments.

## Requirements

### Requirement 1: Password-based sign-in credential

**User Story:** As a returning user, I want to sign in with an identifier and a secret, so that only I
can establish a session as myself.

#### Acceptance Criteria

1. WHEN a sign-in request presents an email and a password that match a stored user credential, THE Auth_Service SHALL issue a Session_Token whose lifetime is bounded by the configured session TTL, return the raw token exactly once, and return the token expiry as an RFC 3339 timestamp.
2. IF a sign-in request presents an email with no matching user, THEN THE Auth_Service SHALL respond with HTTP 401 and Error_Envelope code `UNAUTHENTICATED`.
3. IF a sign-in request presents an email whose stored password does not match the presented password, THEN THE Auth_Service SHALL respond with HTTP 401 and Error_Envelope code `UNAUTHENTICATED`.
4. THE Auth_Service SHALL return an identical HTTP 401 `UNAUTHENTICATED` response for an unknown email and for a wrong password, so that a caller cannot determine which addresses are registered.
5. THE Auth_Service SHALL store each user password as a salted one-way hash and SHALL NOT store the password in a recoverable form.
6. WHEN the Auth_Service verifies a presented password against a stored user, THE Auth_Service SHALL compare using a constant-time verification.
7. IF a sign-in request body exceeds 4096 bytes, THEN THE Auth_Service SHALL respond with HTTP 400 and Error_Envelope code `BAD_REQUEST`.
8. IF a sign-in request omits the email field, omits the password field, or presents either as a non-string, THEN THE Auth_Service SHALL respond with HTTP 400 and Error_Envelope code `VALIDATION_FAILED` identifying the offending field.

### Requirement 2: Sign-up and account creation

**User Story:** As a new user, I want to create an account, so that I can start using Berry.

#### Acceptance Criteria

1. WHEN a sign-up request presents an email that is not already registered and a password meeting the password policy, THE Auth_Service SHALL create a user record and store the password as a salted one-way hash.
2. WHEN a sign-up request successfully creates a user, THE Auth_Service SHALL respond with HTTP 201, issue a Session_Token for the new user, return the new user's id, and SHALL NOT return the stored password hash.
3. IF a sign-up request presents an email that is already registered, THEN THE Auth_Service SHALL respond with HTTP 409 and Error_Envelope code `CONFLICT`, SHALL NOT create a user record, and SHALL NOT reveal the existing user's details.
4. IF a sign-up request presents a password shorter than 12 characters or longer than 128 characters, THEN THE Auth_Service SHALL respond with HTTP 400 and Error_Envelope code `VALIDATION_FAILED` identifying the `/password` field and SHALL NOT create a user record.
5. IF a sign-up request presents an email that does not match the email format `[^\s@]+@[^\s@]+\.[^\s@]+` or exceeds 320 characters, THEN THE Auth_Service SHALL respond with HTTP 400 and Error_Envelope code `VALIDATION_FAILED` identifying the `/email` field and SHALL NOT create a user record.
6. WHEN a repeated sign-up request carries the same `Idempotency-Key` header and a byte-identical body as a prior successful sign-up, THE Auth_Service SHALL return the original HTTP 201 result rather than creating a second user.
7. IF a sign-up request carries the same `Idempotency-Key` as a prior request but a non-identical body, THEN THE Auth_Service SHALL respond with HTTP 409 and Error_Envelope code `IDEMPOTENCY_CONFLICT` and SHALL NOT create a user record.
8. IF a sign-up request carries an `Idempotency-Key` that is not one visible-ASCII value of 16 to 128 characters, THEN THE Auth_Service SHALL respond with HTTP 400 and Error_Envelope code `VALIDATION_FAILED`.

### Requirement 3: Session lifecycle

**User Story:** As a user, I want my session to be created, validated, expire, and be revocable, so that
my access is bounded and I can end it deliberately.

#### Acceptance Criteria

1. WHEN the Auth_Service issues a Session_Token, THE Auth_Service SHALL generate an opaque token of at least 256 bits of random entropy, persist only its SHA-256 hash, and store an expiry timestamp in UTC computed as the issue time plus a configured session TTL that is at least 300 seconds and at most 2,592,000 seconds.
2. IF the Auth_Service is requested to issue a Session_Token while the configured session TTL is outside the range 300 to 2,592,000 seconds, THEN THE Auth_Service SHALL NOT issue a token and SHALL respond with HTTP 500 and an Error_Envelope indicating a server configuration error.
3. WHEN Session_Middleware resolves a Session_Token whose stored expiry is strictly after the current UTC time and whose revocation timestamp is null, THE Session_Middleware SHALL resolve the associated User and update the session's last-used timestamp within the same atomic database operation that verifies liveness.
4. IF Session_Middleware resolves a Session_Token whose stored expiry is at or before the current UTC time, THEN THE Session_Middleware SHALL respond with HTTP 401 and Error_Envelope code `UNAUTHENTICATED`.
5. IF Session_Middleware resolves a Session_Token that has been revoked, THEN THE Session_Middleware SHALL respond with HTTP 401 and Error_Envelope code `UNAUTHENTICATED`.
6. WHEN a sign-out request presents the Session_Token used to authenticate it, THE Auth_Service SHALL set that session's revocation timestamp to the current UTC time and respond with HTTP 204.
7. WHEN a sign-out request presents a Session_Token that does not match any stored session hash, THE Auth_Service SHALL respond with HTTP 204 without disclosing whether the token existed.
8. WHEN a Session_Token has been revoked by sign-out, THE Session_Middleware SHALL reject every subsequent request presenting that token with HTTP 401 and Error_Envelope code `UNAUTHENTICATED`.
9. THE Auth_Service SHALL return a byte-for-byte identical HTTP 401 `UNAUTHENTICATED` Error_Envelope for an absent Authorization header, a malformed token, an expired session, and a revoked session, so that a caller learns nothing about why a credential failed.

### Requirement 4: Authentication required on protected endpoints

**User Story:** As a workspace owner, I want unauthenticated requests to workspace data rejected, so that
no data is reachable without a valid credential.

#### Acceptance Criteria

1. IF a request to a workspace-scoped endpoint carries no Authorization header, THEN THE Session_Middleware SHALL respond with HTTP 401 `UNAUTHENTICATED` and SHALL NOT invoke the route handler.
2. IF a request carries an Authorization header whose scheme is not a case-insensitive `Bearer`, whose token is empty or whitespace-only, whose token contains non-printable-ASCII characters, or whose token exceeds 4096 characters, THEN THE Session_Middleware SHALL respond with HTTP 401 `UNAUTHENTICATED` and SHALL NOT invoke the route handler.
3. IF a request carries more than one Authorization header, THEN THE Session_Middleware SHALL respond with HTTP 401 `UNAUTHENTICATED`.
4. IF a request carries a well-formed Bearer token that matches no active, non-expired, non-revoked session, THEN THE Session_Middleware SHALL respond with HTTP 401 `UNAUTHENTICATED` and SHALL NOT invoke the route handler.
5. WHEN Session_Middleware matches a token to an active, non-expired, non-revoked session, THE Session_Middleware SHALL attach the resolved User to the request context before invoking the route handler.
6. WHERE an endpoint is workspace-scoped, THE Session_Middleware SHALL require a resolved User before any Workspace_Context is derived.
7. IF credential resolution raises an internal error, THEN THE Session_Middleware SHALL respond with HTTP 401 `UNAUTHENTICATED` rather than HTTP 500 and SHALL NOT invoke the route handler.

### Requirement 5: Server-derived workspace context

**User Story:** As a security reviewer, I want the acting workspace to be derived from the authenticated
session, so that a client cannot assert a workspace it does not belong to.

#### Acceptance Criteria

1. WHEN a workspace-scoped request is processed for an authenticated session, THE Authorizer SHALL derive the caller's identity from the session and the caller's Role for the target Workspace from the caller's Membership as recorded in `workspace_memberships`.
2. THE Authorizer SHALL determine the caller's Role solely from server-side Membership state and SHALL NOT accept a Role, Membership, or workspace-authorization claim supplied in the request body, headers, or query string.
3. WHEN a workspace-scoped mutation names a target resource, THE Authorizer SHALL resolve that resource's owning Workspace from stored data, SHALL scope the mutation to that resolved Workspace, and SHALL NOT use any request-supplied workspace identifier as the mutation scope.
4. WHERE a request supplies a `workspaceId` as a query parameter or path segment, THE Authorizer SHALL treat that value only as a lookup key and SHALL NOT include any workspace-scoped data in the response until the caller's Membership in the identified Workspace is confirmed.
5. IF a request supplies a `workspaceId` that identifies a Workspace in which the caller has no Membership, THEN THE Authorizer SHALL respond with HTTP 404 and Error_Envelope code `NOT_FOUND`, indistinguishable from the response for a Workspace that does not exist.
6. IF a workspace-scoped mutation names a target resource that does not exist or resolves to a Workspace in which the caller has no Membership, THEN THE Authorizer SHALL respond with HTTP 404 and Error_Envelope code `NOT_FOUND`, indistinguishable between the two cases, and SHALL leave stored data unchanged.

### Requirement 6: No cross-workspace read access

**User Story:** As a workspace member, I want data from other workspaces to be invisible to me, so that
tenant boundaries are absolute.

#### Acceptance Criteria

1. WHEN an authenticated caller lists a workspace-scoped collection, THE Authorizer SHALL return only rows belonging to Workspaces in which the caller holds a Membership, paged within the endpoint's configured maximum page size.
2. IF an authenticated member of one Workspace requests a single resource that belongs to a Workspace in which the caller has no Membership, THEN THE Authorizer SHALL respond with HTTP 404 `NOT_FOUND`.
3. THE Authorizer SHALL return an HTTP 404 `NOT_FOUND` response for a resource in another Workspace that is indistinguishable — in status, Error_Envelope body, and response headers — from the response for a resource that does not exist.
4. WHEN an authenticated caller requests a workspace-scoped search, THE Authorizer SHALL restrict every returned node to the caller's Workspace_Context.
5. WHILE a caller holds no Membership in any Workspace, THE Authorizer SHALL return an empty collection for every workspace-scoped list request rather than data from another Workspace.

### Requirement 7: No cross-workspace write access

**User Story:** As a workspace owner, I want members of other workspaces unable to modify my data, so
that isolation covers mutations as well as reads.

#### Acceptance Criteria

1. IF an authenticated caller attempts to create, update, or delete a resource in a Workspace in which the caller has no Membership, THEN THE Authorizer SHALL reject the mutation with HTTP 404 and Error_Envelope code `NOT_FOUND` and SHALL leave the target resource and Workspace unchanged.
2. WHEN an authenticated caller performs a workspace-scoped mutation, THE Authorizer SHALL confirm the caller's Membership Role carries the Permission required for that mutation, per the role-permission matrix, before any write is issued.
3. IF an authenticated caller holds a Membership whose Role lacks the required Permission, THEN THE Authorizer SHALL respond with HTTP 403 and Error_Envelope code `FORBIDDEN`, indicate the required Permission was not held, and SHALL NOT modify any stored data.
4. WHEN a mutation references one or more related resources by identifier, THE Authorizer SHALL verify that every referenced related resource belongs to the same Workspace as the mutation's target before applying the change.
5. IF a mutation references a related resource that belongs to a different Workspace or does not exist, THEN THE Authorizer SHALL reject the mutation with HTTP 404 and Error_Envelope code `NOT_FOUND`, indistinguishable between the two cases, and SHALL NOT modify any stored data.
6. WHILE a workspace-scoped mutation is applied, THE Authorizer SHALL perform its authorization checks and the write within a single database transaction that rolls back on any failure, so that no partial modification is persisted.

### Requirement 8: Role-based permission enforcement

**User Story:** As a workspace admin, I want each action gated by the acting member's role, so that
capability follows role consistently.

#### Acceptance Criteria

1. WHEN the Authorizer evaluates a workspace-scoped action for an authenticated caller, THE Authorizer SHALL grant the action if and only if the caller's Role maps to the Permission required by that action in the roles.ts role-permission matrix, and SHALL otherwise reject the action.
2. IF the caller is not authenticated, THEN THE Authorizer SHALL reject the action with HTTP 401 and Error_Envelope code `UNAUTHENTICATED` without evaluating the role-permission matrix.
3. IF the caller's Role is not exactly one of `owner`, `admin`, `member`, or `viewer`, THEN THE Authorizer SHALL treat the caller as having no Permission and SHALL reject the action with HTTP 403 and Error_Envelope code `FORBIDDEN`.
4. IF an action requires the `product.write` Permission AND the caller's Role is `viewer`, THEN THE Authorizer SHALL reject the action with HTTP 403 and Error_Envelope code `FORBIDDEN` and SHALL leave the target resource unchanged.
5. IF an action requires the `settings.write` Permission AND the caller's Role is `member` or `viewer`, THEN THE Authorizer SHALL reject the action with HTTP 403 and Error_Envelope code `FORBIDDEN` and SHALL leave the target resource unchanged.
6. IF an action requires the `members.manage` Permission AND the caller's Role is `member` or `viewer`, THEN THE Authorizer SHALL reject the action with HTTP 403 and Error_Envelope code `FORBIDDEN` and SHALL leave the target resource unchanged.
7. IF an action requires the `owners.manage` Permission AND the caller's Role is not `owner`, THEN THE Authorizer SHALL reject the action with HTTP 403 and Error_Envelope code `FORBIDDEN` and SHALL leave the target resource unchanged.

### Requirement 9: Frontend sign-in, sign-up, and sign-out screens

**User Story:** As a user, I want real sign-in, sign-up, and sign-out screens, so that I control my
session through the UI instead of an automatic prototype login.

#### Acceptance Criteria

1. WHEN an unauthenticated visitor loads a protected route, THE Auth_UI SHALL present the sign-in screen rather than rendering workspace content.
2. WHEN a user submits valid credentials on the sign-in screen, THE Auth_UI SHALL establish a session via the Auth_Service, store the raw Session_Token only in an in-memory holder and tab-scoped `sessionStorage`, and route the user into their Workspace_Context within 2 seconds of the Auth_Service returning success.
3. THE Session_Client SHALL send the Session_Token as an `Authorization: Bearer` header and SHALL NOT place the token in a URL, in build-time configuration, or under any `NEXT_PUBLIC_` variable.
4. WHEN a user activates sign-out and the Auth_Service sign-out endpoint returns success, THE Auth_UI SHALL clear the Session_Token from both the in-memory holder and `sessionStorage` and return the user to the sign-in screen.
5. IF a sign-in submission is rejected with HTTP 401, THEN THE Auth_UI SHALL display a credential error that does not indicate whether the submitted email is registered, and SHALL retain the entered email value in the sign-in form.
6. WHEN the Auth_UI submits credentials, THE Auth_UI SHALL send them to the Berry API only and SHALL NOT transmit them to any third-party origin.
7. WHERE `Passwordless_Login` is disabled, THE Auth_UI SHALL NOT auto-establish a session and SHALL require an explicit sign-in submission before granting access to any protected route.
8. IF the user submits the sign-in form with an empty email or empty password field, THEN THE Auth_UI SHALL block submission to the Auth_Service and display a field-level validation error identifying each empty required field.
9. IF a sign-in submission fails due to a network error or an Auth_Service response other than HTTP 401, THEN THE Auth_UI SHALL display an error indicating the sign-in could not be completed, SHALL NOT establish a session, and SHALL keep the user on the sign-in screen.
10. IF sign-out is activated and the Auth_Service sign-out endpoint does not return success within 5 seconds, THEN THE Auth_UI SHALL clear the Session_Token from both the in-memory holder and `sessionStorage`, return the user to the sign-in screen, and display a notice that the session was ended locally.

### Requirement 10: Workspace onboarding journey

**User Story:** As a new user, I want to select, create, or join a workspace after signing in, so that I
land in a valid Workspace_Context.

#### Acceptance Criteria

1. WHILE an authenticated user holds Membership in at least one Workspace, THE Auth_UI SHALL route the user into a selected Workspace_Context — the previously selected Workspace if that Membership is still valid, otherwise the earliest-joined Membership — within 2 seconds, and SHALL NOT present workspace creation as a required step.
2. IF an authenticated user holds no Membership in any Workspace, THEN THE Auth_UI SHALL present a workspace creation or join step before rendering any workspace content.
3. WHEN an authenticated user creates a Workspace, THE Auth_Service SHALL record the creator as a Membership with Role `owner` and SHALL set the creator's selected Workspace to the new Workspace.
4. WHEN an authenticated user selects a Workspace in which the user holds Membership, THE Auth_Service SHALL record that Workspace as the user's selected Workspace.
5. IF an authenticated user attempts to select a Workspace in which the user holds no Membership, THEN THE Auth_Service SHALL respond with HTTP 404 `NOT_FOUND` and SHALL NOT change the user's selected Workspace.
6. WHEN an authenticated user accepts a valid, unexpired, unrevoked invitation issued to the user's authenticated identity, THE Auth_Service SHALL create at most one Membership for the user in that Workspace with the invitation's Role, creating none if a Membership already exists.
7. IF an authenticated user presents an invitation token that is expired, revoked, already accepted, or not issued to the user's identity, THEN THE Auth_Service SHALL respond with an Error_Envelope and SHALL NOT create a Membership.
8. WHEN the Auth_Service accepts an invitation, THE Auth_Service SHALL mark that invitation as consumed so that any subsequent presentation of the same invitation is rejected per criterion 7.

### Requirement 11: Passwordless login restricted to non-production

**User Story:** As an operator, I want the passwordless prototype login unavailable in production, so
that the hardened auth path is the only way in where it matters.

#### Acceptance Criteria

1. WHERE the runtime environment is any value other than `development` or `test` (including `production`), THE Auth_Service SHALL respond to a `Passwordless_Login` request with HTTP 404 and Error_Envelope code `ROUTE_NOT_FOUND`, regardless of the value of the `AUTH_ALLOW_PASSWORDLESS_LOGIN` flag.
2. WHERE `AUTH_ALLOW_PASSWORDLESS_LOGIN` is disabled, THE Auth_Service SHALL respond to a `Passwordless_Login` request with HTTP 404 and Error_Envelope code `ROUTE_NOT_FOUND`, even when the runtime environment is `development` or `test`.
3. WHERE the runtime environment is `development` or `test` AND `AUTH_ALLOW_PASSWORDLESS_LOGIN` is enabled, WHEN a `Passwordless_Login` request identifies an existing, active target account, THE Auth_Service SHALL issue a Session_Token through the same session-issuance path used by password sign-in.
4. WHERE `Passwordless_Login` is available, IF a `Passwordless_Login` request identifies a target account that does not exist or is not active, THEN THE Auth_Service SHALL reject the request without issuing a Session_Token and respond with an Error_Envelope indicating the target account is invalid.

### Requirement 12: Wire contract preservation

**User Story:** As an API client, I want the existing contract preserved, so that this change does not
break integrations.

#### Acceptance Criteria

1. THE Auth_Service SHALL serve authentication endpoints under the `/api/v1` prefix.
2. WHEN the Auth_Service or Authorizer returns a failure, THE response body SHALL be an Error_Envelope of the form `{ "error": { "code": "<SCREAMING_SNAKE_CASE>", "message": "<text>" } }`.
3. THE Authorizer SHALL page workspace-scoped collections using the existing cursor pagination shape `{ "nodes": [...], "pageInfo": { "hasNextPage": <bool>, "endCursor": <cursor|null> } }`, where `endCursor` is null exactly when `hasNextPage` is false.
4. WHERE a creating POST carries no `Idempotency-Key`, THE Auth_Service SHALL process it as a new request without idempotency deduplication.
5. WHEN a creating POST is repeated with the same `Idempotency-Key` and a byte-identical body within the idempotency retention window, THE Auth_Service SHALL return the original resource rather than creating a duplicate.
6. IF a creating POST is repeated with the same `Idempotency-Key` and a non-identical body, THEN THE Auth_Service SHALL respond with HTTP 409 and Error_Envelope code `IDEMPOTENCY_CONFLICT`.
7. THE Auth_Service SHALL NOT add or remove fields from the existing serialized `user`, `workspace`, or `member` response shapes as part of this feature.
