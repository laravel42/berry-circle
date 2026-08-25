# ADR-0006: Store agent run artifacts in object storage, indexed as attachments

- **Status:** Accepted
- **Date:** 2026-08-24
- **Deciders:** Berry platform
- **Related:** [ADR-0004](0004-go-product-server.md) (Go product server),
  [ADR-0005](0005-temporal-run-orchestration.md) (Temporal run orchestration),
  [Berry ↔ OpenFang integration](../integrations/berry-openfang.md),
  [Gateway API contract](../api/gateway-v1.md)

## Context

An agent run produces files: a report, a diff, a chart, a transcript. Today
those files land in the runtime's own filesystem at
`/data/workspaces/<agent>` on the `openfang-data` volume, and nothing else
happens to them.

That location fails the product in four ways:

- **It is keyed by agent, not by run.** Two runs by the same agent share one
  directory, so "what did this run produce" has no answer and a later run can
  overwrite an earlier one's output.
- **Berry cannot address it.** No row references those bytes, so nothing can be
  listed, linked from an issue, downloaded, or shown in a review.
- **It escapes workspace scoping.** The runtime has one flat filesystem; Berry
  scopes everything else to a workspace. An artifact there is outside every
  access rule Berry enforces.
- **It grows without bound.** Nothing expires or accounts for it.

Berry already has the pieces this needs. `internal/storage` is a real object
boundary — a `Backend` with `Put`/`Open`/`Delete`, a richer `MetadataBackend`
carrying content type and SHA-256, presigned GET and PUT so bytes never proxy
through the API, and two implementations (`Local` for development, S3 for
deployment, with `S3_ENDPOINT` and path-style addressing so any S3-compatible
service works). The `attachments` table is its metadata ledger: `storage_key`,
`content_type`, `size_bytes`, `checksum_sha256`, and a `state` that moves
`pending → ready` so a half-written upload is never served as complete.

What that machinery cannot express is an artifact produced by an agent:

- `attachments.uploader_id` references `users` and nothing else. Every
  attachment is attributed to a human. An agent has no way to be the author of
  its own output.
- No column links an attachment to the run that produced it.

Every other table that records who did something already solved this. `comments`
carries `author_type` + `author_id`, and `conversation_messages`,
`inbox_items`, `assignments` and `issues` follow the same shape: an actor kind
beside an actor id. Attachments are the one place the pattern was not applied.

## Decision drivers

- An artifact must be reachable from the run and the issue it belongs to.
- Agent-authored and human-authored artifacts belong in one place; a parallel
  store would drift from the checksum, state machine, presigning and access
  rules `attachments` already has.
- Attribution must survive: a reader has to see whether a person or an agent
  produced a file, and which one.
- The runtime is a substrate, not a product store. Berry does not build
  features on the durability of an OpenFang volume.
- Deployment storage is S3-compatible; development must not require an AWS
  account.

## Considered options

1. **Leave artifacts in the runtime workspace and read them on demand.**
   Cheapest, and wrong: it makes Berry's product surface depend on a volume it
   does not own, keyed by agent rather than run, with no scoping or lifecycle.
2. **A separate `artifacts` table and store.** Clean separation, but duplicates
   checksums, upload states, presigning, and authorization, and guarantees the
   two diverge. It also forces every consumer to ask which of two places a file
   is in.
3. **Extend `attachments` with an actor kind and a run link.** Reuses the
   ledger, the state machine and the access path; one query answers "what did
   this run produce"; artifacts appear wherever attachments already do.

## Decision

**Agent-produced artifacts are ordinary attachments, stored in Berry's object
storage and indexed by the `attachments` table.**

- `attachments` gains `uploader_type` (the existing `assignee_type` enum,
  `user` or `agent`) paired with the existing `uploader_id`. The pair is
  both-or-neither and the id must resolve in the table the kind names —
  enforced by constraint, not convention, matching `comments.author_type`.
- `attachments` gains a nullable `run_id` referencing `runs`. Null means the
  artifact did not come from a run; a value makes "what did this run produce" a
  single indexed query. The reference is `ON DELETE SET NULL`: deleting a run's
  bookkeeping must not destroy the file it produced.
- **Deployments store artifacts in S3.** `STORAGE_BACKEND=s3` with
  `S3_BUCKET`/`S3_REGION`, and `S3_ENDPOINT` plus path-style addressing for
  S3-compatible services. The local compose stack runs MinIO so development
  exercises the same code path as production rather than a filesystem that
  behaves differently under presigning.
- Object keys are workspace-scoped and content-addressed by run, so a key can
  never collide across workspaces and an artifact's location states where it
  belongs.
- The runtime workspace stays what it is: **scratch space**. Files there are not
  product state, are not backed up, and may be removed. An artifact becomes
  real when it is promoted into the store and a row exists for it.

## Consequences

### Positive

- One store, one ledger, one access path for every file Berry holds.
- Run detail can list outputs; issue attachments show agent work beside human
  uploads with the author visible.
- Artifacts inherit presigned upload and download, so bytes never pass through
  the API even at S3 sizes.
- Deleting a run keeps its artifacts; deleting an issue removes them with it,
  which is the cascade `attachments` already declares.

### Negative

- `uploader_id` can no longer be a plain foreign key to `users`, because the
  target table now depends on `uploader_type`. Referential integrity for the
  agent case is enforced by trigger rather than by a foreign key.
- Development gains a MinIO container. That is deliberate: a local filesystem
  backend hides presigning and content-type bugs until deployment.

### Risks and mitigations

- **Risk:** An agent writes unbounded output and storage grows without limit.
  **Mitigation:** `STORAGE_MAX_BYTES` caps a single object. A retention policy
  for run artifacts is follow-up, not part of this decision, and is recorded
  below rather than left implicit.
- **Risk:** A promoted artifact is attributed to the wrong agent, making a
  review trail misleading. **Mitigation:** the uploader pair is constrained and
  the run link is a real reference; neither can be set to a value that does not
  resolve.
- **Risk:** MinIO and AWS S3 diverge in behaviour. **Mitigation:** the same
  `S3` backend drives both, differing only by endpoint and addressing style, so
  a divergence surfaces as a failing request rather than a silent difference.

## Validation

- Migration tests assert the constraint rejects a mismatched
  `uploader_type`/`uploader_id` pair, and that deleting a run leaves its
  artifacts with a null `run_id` rather than removing them.
- Repository tests cover listing artifacts by run and by issue.
- The compose stack starts MinIO and the server reaches it with
  `STORAGE_BACKEND=s3`, so the S3 path is exercised on every local run rather
  than only in deployment.

## Follow-up

- Retention for run artifacts: what expires, when, and who accounts for the
  spend. Not decided here.
- The promotion path from a runtime workspace into the store — which files a
  finished run offers as artifacts, and whether the agent or the gateway
  chooses — is a separate change against the OpenFang contract.
