# Berry — Release-Readiness Report Template

*Release 1 · Release reporting · BERR-48*

A release-candidate (RC) gate. One report per RC, filled in before the RC is
merged and deployed, capturing **what shipped**, **whether it is tested**,
**what is still broken**, and a **go/no-go decision** with evidence.

The report is the artifact the RC owner and reviewers look at to decide whether
the candidate is ready. Every claim in it must trace back to a commit, PR, CI or
local check output, or a tracked issue — never an assertion on trust. If a field
cannot be filled, write `Unknown` or `N/A` and say why; do not leave it blank.

## How to use this template

1. Copy the section below the `<!-- BEGIN TEMPLATE -->` marker into a new file
   `docs/releases/rc-<version>.md` (e.g. `docs/releases/rc-0.1.0.md`). Keep this
   template file unchanged so the next RC can reuse it.
2. Replace every `<placeholder>` and fill every table row. Delete guidance
   comments (`<!-- ... -->`) as you go.
3. Ground each entry: link the PR (`#123`), the issue (`BERR-NN`), or paste the
   command and its result. Cite a check honestly, including partial failures —
   "Pass" with no evidence is not acceptable, and a skipped suite is reported as
   skipped rather than as a pass.
4. Record the go/no-go decision last, after every check above it has a result.
5. Deliver the finished report as the issue comment on the RC's tracking issue
   and commit the file. Cross-link it from the changelog entry for the release.

> **Decision authority (Release 1).** Per the project pipeline gates, the human
> release gate is **waived for the Release 1 cycle**: an RC whose issue-level PRs
> each passed a clean adversarial reviewer check (Sentinel for frontend, Backend
> PR Adversary for backend) with no blocking findings may proceed to merge and
> deploy without human sign-off. Record which check(s) cleared the RC. This
> waiver is reinstated as a human gate in later cycles unless re-confirmed.

---

<!-- BEGIN TEMPLATE -->

# Release-Readiness Report — RC `<version>`

| Field | Value |
| --- | --- |
| RC / version | `<version>` (e.g. `0.1.0`) |
| Target milestone | `<M0–M6>` — `<milestone name>` |
| Date | `<YYYY-MM-DD>` |
| Prepared by | `<agent or person>` |
| Deciders | `<reviewer(s) / owner>` |
| First consumer / trigger | `<BERR-NN — what this RC is cut for>` |
| Related | Changelog `<link/anchor>` · Release report `<link>` |

## 1. Scope delivered

<!-- Every change included in this RC. One row per merged issue/PR. Mark
     anything planned-but-deferred as Deferred and link where it moved to. -->

| Issue | PR | Summary | Status |
| --- | --- | --- | --- |
| `BERR-NN` | `#NN` | `<one-line summary>` | Merged / Deferred |

**Out of scope / deferred:** `<items intentionally not in this RC, with issue links>` — or `None`.

## 2. Test state

<!-- Berry has no in-repo CI workflow yet; these checks run locally and at the
     PR review gate. Record the actual result and cite evidence (command output,
     PR check, or the smoke report). "Pass" with no evidence is not acceptable. -->

| Check | Command | Result | Evidence |
| --- | --- | --- | --- |
| Server tests | `pnpm test:server` | Pass / Fail / N/A | `<PR check / log>` |
| Server typecheck | `pnpm typecheck:server` | Pass / Fail / N/A | `<log>` |
| Server DB tests | `BERRY_TEST_DATABASE_URL=… pnpm test:server` | `<N ran / N skipped>` | `<log>` |
| Compose invariants | `python3 scripts/check-compose-config.py` | Pass / Fail / N/A | `<log>` |
| Frontend build | `cd frontend && pnpm build` | Pass / Fail / N/A | `<log>` |
| Frontend lint | `cd frontend && pnpm lint` | Pass / Fail / N/A | `<log>` |

**Coverage gaps / not exercised:** `<what these checks do NOT cover for this RC>` — or `None`.

## 3. Known issues

<!-- Every open defect or risk that ships with this RC. Severity drives the
     go/no-go: any Blocking row is an automatic NO-GO until resolved or
     explicitly waived by the deciders. -->

| Issue | Severity | Impact | Workaround | Blocks release? |
| --- | --- | --- | --- | --- |
| `BERR-NN` | Blocking / High / Medium / Low | `<user-visible effect>` | `<workaround or "none">` | Yes / No |

**Residual risk:** `<risks accepted for this RC and why they are acceptable>` — or `None`.

## 4. Go / No-Go checklist

<!-- Mark each Go / No-Go / N/A with a one-line reason or evidence link.
     A single No-Go on a required item blocks the release. -->

| # | Gate | Status | Evidence / note |
| --- | --- | --- | --- |
| 1 | All in-scope items merged, or deferred with an issue link | Go / No-Go | |
| 2 | Test state above is green (or every failure is triaged non-blocking) | Go / No-Go | |
| 3 | Each issue PR has a clean adversarial reviewer check, no blocking findings | Go / No-Go | |
| 4 | No open **Blocking** or **High** known issue without an accepted waiver | Go / No-Go | |
| 5 | Deploy artifact builds and boots; env/config documented | Go / No-Go | |
| 6 | Rollback / revert path documented and viable | Go / No-Go | |
| 7 | Changelog updated; upgrade/migration notes written where APIs changed | Go / No-Go | |
| 8 | Release sign-off recorded (R1: reviewer-clean is sufficient; human gate waived) | Go / No-Go | |

## Decision

**`GO` / `NO-GO` / `CONDITIONAL GO`** — `<YYYY-MM-DD>`, by `<decider>`.

`<One-paragraph rationale. If CONDITIONAL GO, list the exact conditions and who
verifies each before deploy. If NO-GO, list the blockers and their issues.>`

<!-- END TEMPLATE -->

---

*Sources: project pipeline gates (Berry — Web App, Release 1); the root and
frontend `package.json` scripts.*
