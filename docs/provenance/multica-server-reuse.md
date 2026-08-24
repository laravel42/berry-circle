# Multica server reuse provenance

## Pinned source

- **Repository:** [`https://github.com/multica-ai/multica`](https://github.com/multica-ai/multica)
- **Commit:** [`8c9b7503a12ded3f28553da48b9851621f10be6b`](https://github.com/multica-ai/multica/tree/8c9b7503a12ded3f28553da48b9851621f10be6b)
- **Recorded:** 2026-08-22

This commit is the only Multica baseline approved by this record. Inspection and
future extraction must address committed Git objects at this revision, not the
contents of a sibling working tree. Moving the baseline requires a reviewed
provenance update and a corresponding update to the
[web parity matrix](../parity/multica-web.md).

## Owner authorization

On 2026-08-22, the person directing Berry's development represented that they
control Multica's relevant rights and explicitly authorized Berry to reuse,
adapt, and relicense the approved first-party Multica material in Berry. This
file records that owner-supplied authorization. It does **not** claim that an
external lawyer or other independent party reviewed the ownership, license, or
provenance.

Authorization from the owner does not change the licenses of third-party code,
generated material, bundled assets, or dependencies. Those remain subject to
their own terms and must pass Berry's review before reuse.

## Approved and excluded scope

The approved source scope is limited to first-party Go product/control-plane
patterns and code that help implement Berry's browser-facing product server,
including suitably reviewed handlers, services, PostgreSQL queries and
migrations, authorization patterns, realtime product events, and tests.
Adaptation must preserve Berry's own domain language, public API, security
boundary, and product behavior.

The following Multica material is outside the approved import scope:

- legacy UI code, assets, copy, product names, logos, and branding;
- desktop and mobile applications or platform glue;
- CLI and daemon code, daemon WebSocket protocols, and local launchers;
- model/provider adapters, agent execution loops, sandboxing, and filesystem
  execution.

Those execution responsibilities remain with OpenFang, as described by the
[integration specification](../integrations/berry-openfang.md) and
[ADR-0004](../adr/0004-go-product-server.md). An excluded implementation may be
read to understand a product contract, but its code must not be ported into
Berry.

## Dependency and code audit

Owner authorization is necessary but not sufficient for an import. Before any
Multica-derived unit lands, its pull request must:

1. identify the exact Multica source path and the pinned commit above;
2. distinguish copied code from adapted patterns and summarize material edits;
3. inspect file headers, generated-code inputs, embedded assets, and relevant
   Git history for third-party origin;
4. audit every introduced or transitive shipped dependency and record its
   license;
5. confirm compatibility with Berry's MIT/Apache-2.0-only (or equivalently
   permissive) dependency rule; and
6. reject or independently reimplement anything whose provenance or license is
   unclear.

The authorization in this document is not a blanket dependency exception.
Copyleft, source-available, unknown-license, and branding-restricted material
remain ineligible for the shipped product.

## Recording future reuse

Every future import or substantial adaptation must append a row before merge.
Use one row per cohesive source-to-target mapping; use `None` only when the
change contains no Multica-derived code.

| Berry path | Multica path | Source commit | Reuse form | Dependency/license audit | Reviewer and date |
|---|---|---|---|---|---|
| `server/` shared platform scaffold | `server/cmd/server/main.go` (startup/shutdown ordering); `server/cmd/migrate/main.go` (session-pinned advisory lock); `server/internal/realtime/hub.go` (bounded subscriber backpressure); `server/internal/storage/local.go` (atomic local writes and containment) | `8c9b7503a12ded3f28553da48b9851621f10be6b` | Berry-native implementation informed by the named behavioral patterns; no legacy source copied. Berry uses its own API, migration squash, domain language, OpenFang boundary, and tests. | [`server/THIRD_PARTY_NOTICES.md`](../../server/THIRD_PARTY_NOTICES.md) plus the scaffold dependency audit | Implementation record; reviewer pending · 2026-08-22 |
| `server/internal/identity/`, `server/internal/handlers/identity/`, `server/internal/auth/credentials.go`, `server/migrations/004_identity_workspaces.up.sql` | `server/internal/middleware/workspace.go`; `server/internal/handler/invitation.go`; `server/internal/handler/personal_access_token.go`; migrations `011` and `041` | `8c9b7503a12ded3f28553da48b9851621f10be6b` | Berry-native implementation informed by hidden workspace-membership boundaries, invitation lifecycle, one-time token return, hash-only token storage, expiry, last-use, and idempotent revocation behavior. No source code, product naming, daemon/cloud execution, or legacy API shape was copied. | No new dependency; existing Go dependency audit remains unchanged | Implementation record; reviewer pending · 2026-08-22 |

If a later change draws from another Multica commit, record a new pin and
review the delta; never silently replace the commit in an existing row.
