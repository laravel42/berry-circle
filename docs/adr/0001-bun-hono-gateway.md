# ADR-0001: Use Bun and Hono for the gateway

- **Status:** Superseded by [ADR-0004](0004-go-product-server.md)
- **Date:** 2026-08-22
- **Deciders:** Berry architecture team
- **Related:** [Product brief](../product-brief.md),
  [OpenFang integration specification](../integrations/berry-openfang.md),
  [ADR-0004](0004-go-product-server.md)

## Context

Berry needs a server-side gateway that presents a stable product API to the web
client while adapting the external agent substrate. It must validate product
DTOs, proxy ordinary HTTP requests, consume and relay SSE without buffering the
whole response, and keep upstream credentials out of browsers. Release 1 uses
TypeScript throughout the gateway and frontend.

The repository already contains the initial `apps/gateway` service built on Bun
and Hono. This ADR makes that established choice explicit and defines its
boundary.

## Decision drivers

- Efficient streaming through native Fetch API and Web Streams primitives.
- A small TypeScript HTTP layer with explicit middleware and route composition.
- One runtime for local development, dependency management, tests, and the
  production gateway process.
- A server-side adapter boundary that shields the frontend from upstream API
  and authentication changes.

## Considered options

1. Bun runtime with Hono.
2. Node.js runtime with a larger HTTP framework.
3. Direct browser-to-substrate integration without a Berry gateway.

## Decision

Run the Berry gateway on Bun and use Hono for HTTP routing and middleware.
Gateway code uses TypeScript, native `fetch`, and Web Streams/SSE primitives.
Request and response boundaries are validated with Zod.

The gateway is the browser-facing boundary for both Berry-owned resources and
adapted substrate capabilities. Browsers must not call the substrate directly
or receive its credential. Product data remains in Berry's PostgreSQL model;
Hono and Bun do not alter that ownership boundary.

Runtime- or framework-specific APIs must stay behind the gateway's application
and adapter boundaries where practical, so a future migration does not leak
into public API contracts.

## Consequences

### Positive

- Streaming can flow through standards-based primitives with little adaptation.
- The service has a compact dependency and deployment surface.
- Gateway and frontend teams share TypeScript types and tooling concepts.
- Upstream changes can be absorbed in one server-side adapter.

### Negative

- The team accepts Bun-specific operational behavior and a smaller ecosystem
  than Node.js.
- Some third-party packages may assume Node.js and require compatibility
  verification before adoption.
- Bun and Hono upgrades become controlled platform changes rather than routine
  dependency bumps.

### Risks and mitigations

- **Risk:** A dependency works under Node.js but not Bun. **Mitigation:** Require
  a Bun smoke test before adding gateway dependencies and prefer Web-standard
  APIs.
- **Risk:** Streaming is accidentally buffered by middleware. **Mitigation:**
  Cover incremental SSE delivery and disconnect handling in integration tests.
- **Risk:** Framework types become the public contract. **Mitigation:** Keep
  product DTO schemas separate from Hono handler types.

## Validation

- `apps/gateway` starts and serves its health route under Bun.
- Type checking, linting, and `bun:test` pass in the gateway package.
- Integration tests prove SSE chunks are relayed incrementally and upstream
  credentials are never returned to clients or written to logs.

## Follow-up

- Record any future runtime or framework replacement in a superseding ADR.
