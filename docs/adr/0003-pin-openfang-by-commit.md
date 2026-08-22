# ADR-0003: Pin and validate the OpenFang integration by commit

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** Berry architecture team
- **Related:** [OpenFang integration specification](../integrations/berry-openfang.md),
  [ADR-0001](0001-bun-hono-gateway.md)

## Context

Berry consumes an external execution substrate with a broad REST, WebSocket,
SSE, and compatibility API. The upstream `/api` paths are not versioned, and
router behavior can be more complete than its generated or published endpoint
summary. Building against a moving branch or a mutable image tag would make
Berry's deployed contract ambiguous and could introduce unreviewed changes to
payloads, authentication, status codes, or event streams.

The initial Berry integration contract was verified against upstream commit
`acf2587e46be174c10200489c9a2d23a39a98aeb`.

## Decision drivers

- Reproducible development, CI, and deployment environments.
- A precise source baseline for API and SSE contract verification.
- Deliberate review of upstream behavior and licensing changes.
- A rollback target when an upstream upgrade is incompatible.

## Considered options

1. Pin the exact 40-character upstream commit and validate the adapter against
   it.
2. Track a release tag or mutable container tag.
3. Track the upstream default branch.

## Decision

Berry's supported upstream version is identified by an immutable, full Git
commit SHA. The initial pin is
`acf2587e46be174c10200489c9a2d23a39a98aeb`.

Deployment configuration must resolve to artifacts built from that commit and,
where an image digest is available, pin the digest as well. A tag may be kept as
human-readable metadata but is not the reproducibility boundary. The gateway
must communicate with the substrate only through an adapter whose tested
contract corresponds to the pinned commit.

An upgrade is a reviewed change that must:

1. select a new immutable commit and verify its provenance and license;
2. compare mapped routes, request/response shapes, authentication, status codes,
   and SSE events with the current pin;
3. update the integration specification and adapter tests for every change;
4. validate migrations, failure behavior, and rollback against a representative
   environment; and
5. update deployment manifests and recorded image digest atomically with the
   contract change.

Berry does not expose the upstream name or version as product branding. The pin
is engineering and operational metadata.

## Consequences

### Positive

- A deployed Berry release has an auditable and reproducible integration
  baseline.
- Contract drift becomes a visible code-and-documentation change.
- Failures can be reproduced against the same upstream source.
- Rollback has a known compatible target.

### Negative

- Upstream fixes and features are not received automatically.
- Each upgrade requires contract review, tests, and coordinated deployment
  work.
- A source commit alone does not guarantee identical binaries; build inputs and
  image digests must also be controlled.

### Risks and mitigations

- **Risk:** A security fix is delayed by the upgrade process. **Mitigation:**
  Monitor upstream advisories and provide an expedited process that retains the
  same compatibility and regression checks.
- **Risk:** Documentation says one commit while deployment runs another.
  **Mitigation:** Keep the pin in one machine-readable deployment source and add
  CI that compares it with the integration contract baseline.
- **Risk:** Upstream documentation omits real router behavior. **Mitigation:**
  Verify source routes and exercise adapter contract tests against the pinned
  build.

## Validation

- CI runs gateway adapter contract tests against an artifact traceable to the
  recorded commit.
- Deployment manifests use an immutable commit-derived artifact and image digest
  when available.
- The integration specification names the same commit and documents all mapped
  endpoints and known gaps.
- Upgrade pull requests contain the contract comparison and rollback evidence.

## Follow-up

- Add the machine-readable source pin and digest to deployment configuration
  when the upstream service is introduced into Berry's Docker deployment.
- Add a CI consistency check between that pin and the integration specification.
