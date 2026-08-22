# Changelog process

How Berry maintains its changelog. This is the format and workflow reference; the
changelog itself lives at [`CHANGELOG.md`](../CHANGELOG.md) in the repository root.

## Where things live

| File | Purpose |
| ---- | ------- |
| [`CHANGELOG.md`](../CHANGELOG.md) (repo root) | The changelog. One file, newest release first, maintained continuously. |
| `docs/changelog-process.md` (this file) | The format and workflow that governs `CHANGELOG.md`. |

`CHANGELOG.md` sits at the repository root because that is the conventional location tools
and readers expect; this process doc lives under `docs/` alongside the rest of the
knowledge base.

## Format

The changelog follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and
Berry versions follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

- **Newest first.** The `## [Unreleased]` section is always at the top, followed by
  released versions in reverse-chronological order.
- **One heading per release:** `## [x.y.z] - YYYY-MM-DD`, using SemVer for the version and
  an ISO-8601 (UTC) date. Pending work goes under `## [Unreleased]` until a release is cut.
- **Change groups, in this fixed order:** `Added`, `Changed`, `Deprecated`, `Removed`,
  `Fixed`, `Security`. **Omit any group with no entries** — do not leave empty headings.
- **Audience is developers.** Entries are precise and neutral: name the endpoint, config
  key, file, or identifier that changed. Active voice, short sentences, no marketing.

### What each group means

| Group | Use for |
| ----- | ------- |
| `Added` | New features, endpoints, docs, config, or capabilities. |
| `Changed` | Changes to existing behavior. |
| `Deprecated` | Soon-to-be-removed features still present. |
| `Removed` | Features/endpoints/config removed in this release. |
| `Fixed` | Bug fixes to already-shipped (or already-merged) behavior. |
| `Security` | Vulnerability fixes and hardening. Always call these out. |

## Writing an entry

- **One bullet per user- or developer-visible change.** Fold internal churn, refactors,
  and review-round follow-ups that never shipped independently into the entry for the
  feature they belong to — do not list a fix for an unreleased feature separately from the
  feature.
- **Trace every entry to a source.** End each bullet with its Berry issue ID and, where
  one exists, the merged PR — e.g. `— BERR-19 ([#2])`. Direct commits reference the short
  SHA instead. Never invent a change, date, version, issue, or PR that has no such source.
- **Reference links** are defined at the bottom of `CHANGELOG.md` in reference style:
  `[#N]` → `.../pull/N`, `[shortsha]` → `.../commit/shortsha`, and `[Unreleased]` /
  `[x.y.z]` → the appropriate compare or commits URL.
- **Never include secrets, tokens, or credentials** in any entry.

## Versioning policy

- Berry is **pre-release** (0.x) throughout the Release 1 development cycle. No version is
  tagged yet; work accumulates under `## [Unreleased]`.
- The **first tagged release is cut at milestone M6 (Release 1)**. Do not assign a version
  number before then — a version that does not correspond to a git tag and a release is a
  fabrication.
- After 1.0, apply SemVer normally: **MAJOR** for breaking API changes, **MINOR** for
  backward-compatible additions, **PATCH** for backward-compatible fixes. Call out breaking
  changes prominently and include migration steps.

## Cutting a release

When a release is tagged:

1. Rename the `## [Unreleased]` heading to `## [x.y.z] - YYYY-MM-DD` (the tag version and
   its UTC date).
2. Add a fresh, empty `## [Unreleased]` section at the top for the next cycle.
3. Update the reference links at the bottom: point `[x.y.z]` at the version's compare/tag
   URL and repoint `[Unreleased]` to compare from the new tag to `HEAD`.
4. Cross-check every entry against the merged commits/PRs/issues for that range so nothing
   is missing, miscredited, or invented.

## Ownership

Scribe maintains the changelog continuously as part of docs & release reporting
(BERR-8), keeping `## [Unreleased]` current as work merges rather than reconstructing it at
release time.
