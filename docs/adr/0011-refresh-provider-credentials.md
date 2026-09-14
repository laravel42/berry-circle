# ADR-0011: Refresh provider credentials before they expire

- **Status:** Proposed — and largely overtaken. Later the same day Berry gained
  its own GitHub App (migration `040`, `src/integrations/github-app.ts`), which
  mints installation tokens on demand and so has no user token to refresh. This
  record still applies to any provider Berry reaches through user OAuth, and to
  a deployment that has not created an App; it is no longer the fix for GitHub.
- **Date:** 2026-09-01
- **Deciders:** Berry platform
- **Related:** [ADR-0009](0009-typescript-product-server.md) (TypeScript product
  server), `server-ts/src/integrations/connections.ts`,
  `server-ts/src/integrations/oauth.ts`

## Context

Berry's GitHub connection stops working roughly eight hours after it is made,
and stays broken until somebody reconnects by hand.

The credential Berry stores for GitHub is a **user-to-server token**, which
GitHub issues with an eight-hour lifetime and a refresh token beside it. The
OAuth exchange already reads both: `ExchangedCredential` carries
`refreshToken`, `ConnectionRepository.save` seals it, and the column
`integration_connections.refresh_token_encrypted` holds it.

**Nothing ever reads it back.** There is no exchange against
`grant_type=refresh_token` anywhere in the server. The refresh token is written
once and never used, so the access token beside it expires on schedule and the
connection is dead until a person repeats the browser flow.

This was observed on 2026-09-01. The workspace's GitHub connection was made on
2026-08-25 at 10:47 and expired the same day at 18:47 — eight hours later. For
the seven days since, every call has failed:

```
GET /api/v1/integrations/github/repositories
409 CONNECTION_UNUSABLE — "the github credential has expired"
```

Two things made it hard to diagnose. The deployment's `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` are present and correct, which invites the conclusion
that configuration is fine and something else is broken — they are the *app's*
identity, used only to start a flow, and have nothing to do with the token that
expired. And the connection kept reporting itself healthy, which the companion
change to this record fixes: `status` is now derived from `expires_at` rather
than read from a column nothing updates.

## Decision drivers

- A connection that dies every eight hours is not usable for unattended agents,
  which is the entire point of the integration.
- The material to fix it is already stored; only the exchange is missing.
- A person cannot be in the loop for this. Runs are dispatched by a worker, and
  a token that lapses overnight fails work nobody is watching.

## Considered options

1. **Reconnect by hand when it breaks.** What happens today. Rejected: eight
   hours is shorter than a working day, and an agent run is not attended.
2. **Use a GitHub App installation token instead.** Server-to-server, minted
   from the app's private key, no user in the loop. `GITHUB_APP_ID`,
   `GITHUB_APP_SLUG` and `GITHUB_PRIVATE_KEY` are already in the deployment's
   environment, which suggests this was the intent at some point. It is the
   better long-term shape — but it changes what an action is attributed to, and
   the permission model with it.
3. **Refresh the user token before it expires.** Chosen: smallest change, uses
   what is already stored, and keeps attribution as it is.

## Decision

**Refresh a provider credential when it is close to expiry, in the same place
that hands the token out.**

`ConnectionRepository.token` already refuses an expired credential, on a clock
and a margin (`expiryMarginMs`, 60s) that exist precisely to avoid handing out a
token that dies mid-operation. That refusal becomes the trigger: when the margin
is crossed and a refresh token is present, exchange it and hand back the new
access token instead of throwing.

Four properties this needs:

**One refresh at a time.** Two runs starting together must not both exchange the
same refresh token — GitHub invalidates the old one on use, so the loser's
token is dead on arrival. The exchange takes a row lock on the connection, and
the second caller re-reads rather than exchanging.

**Failure is terminal and recorded.** A refresh token that GitHub rejects is not
retried. The row moves to `expired` with a `status_detail` saying so, which is
what the settings page then shows and what makes reconnecting an obvious action
rather than a guess.

**No token in a log or an error.** The exchange happens beside the sealing
already in `save`, so the credential stays inside the one place in the server
where a provider secret is handled in the clear.

**Provider-shaped, not GitHub-shaped.** `exchangeGitHubCode` gains a sibling for
refresh, behind the same options; the repository calls whatever the provider
registers. Slack and the rest expire too, and a GitHub-only path would have to
be written twice.

## Consequences

### Positive

- The connection survives unattended, which is what makes overnight agent runs
  possible at all.
- Nothing new is stored: the refresh token has been collected since the
  integration shipped.
- An expired connection now says so, and says it in one place.

### Negative

- A token exchange enters the dispatch path, so a run can now fail for a reason
  that is neither Berry's nor the agent's.
- The lock serialises concurrent runs briefly at the moment of refresh.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Two callers race and one gets an invalidated token | Row lock; the loser re-reads rather than exchanging |
| Refresh silently fails and work dies at 3am | Terminal state plus `status_detail`, surfaced in the settings page |
| Refresh token itself expires (GitHub: 6 months) | Nothing to do but reconnect — but the status now says which of the two lapsed |
| The exchange leaks a credential into a log | Kept beside the existing sealing; no token crosses a log boundary |

## Validation

- A connection inside the margin with a refresh token returns a *new* access
  token, and the row's `expires_at` moves forward.
- A connection inside the margin with no refresh token still throws
  `ConnectionUnavailable`, as it does today.
- A rejected refresh leaves the row `expired` with a detail, and does not retry.
- Two concurrent `token` calls across the margin perform one exchange.
- Live: a GitHub connection keeps working past the eight-hour mark without
  anyone touching it.

## Follow-up

- Decide whether option 2 — GitHub App installation tokens — supersedes this
  for agent-initiated work. The environment is already configured for it, and
  it would remove the user token from the unattended path entirely.
- `scopes` is stored empty (`{}`) on the current connection. Whatever the cause,
  a connection that does not record what it may do cannot be audited.
