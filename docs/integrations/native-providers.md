# Native integrations

Berry treats GitHub, Slack, Linear, Notion and Gmail as first-class. This
document is the architecture, the reasoning behind it, and what an operator has
to set up.

## The split, and why it exists

The obvious reading of "native integration" is that Berry holds the provider SDK
and makes the calls. Berry does not, and should not, for one reason: **Berry
does not own the agent tool surface.** Agents run inside the OpenFang runtime,
which selects their tools and dispatches their calls — Berry has no seam through
which to place a tool in an agent's context.

The runtime already ships MCP servers for all five providers. So the division is:

| Owned by Berry | Owned by the runtime |
|---|---|
| Which workspace a connection belongs to | Calling the provider's API |
| OAuth, and proving a callback is genuine | Marshalling tool arguments |
| Credentials, encrypted at rest | Returning results to the model |
| Which agent may call which tool | |
| What was done, and by whom | |
| Inbound webhooks, verified and normalised | |

Everything in the left column is missing from the runtime, which is flat and
single-tenant. Everything in the right column already exists there and would
only drift if reimplemented.

**Nothing in Berry imports a provider SDK.** `internal/integrations/providers`
declares what exists and what it costs; it makes no network calls.

## Layout

```
server/internal/
  secrets/                    sealing credentials at rest (AES-256-GCM)
  integrations/
    core/
      types.go                Effect, Connection, Tool, Provider, Decision
      registry.go             provider resolution; no provider-specific branches
      permissions.go          the authorizer — deny by default at every step
    providers/
      github.go slack.go linear.go notion.go gmail.go
    oauth/state.go            CSRF state, redirect allowlist
    webhooks/verify.go        signature verification per provider
```

## The effect ladder

Every tool declares what it does to the outside world, ordered:

```
read  <  write  <  external_side_effect  <  destructive
```

A permission grant carries the strongest effect it allows, and a tool is refused
when its own effect exceeds that. This is what makes "read-only" a comparison
rather than a convention — a read grant cannot execute a write, and no
provider-specific check is needed to enforce it.

The ladder is about **consequence, not HTTP verb**. Posting to Slack and sending
mail are `external_side_effect` rather than `write`: they reach people and
cannot be undone by deleting a record. Merging a pull request is `destructive`.

An unrecognised effect is never permitted, so a tool that fails to classify
itself cannot inherit the weakest rule.

## Permissions

Grants are stored per workspace, optionally per agent, per provider, per tool.

- **Absence denies.** Adding a provider never silently widens what existing
  agents can reach.
- `tool = '*'` grants everything the provider offers, still capped by the
  grant's effect ceiling.
- A grant with no `agent_id` applies workspace-wide; one naming an agent applies
  only to that agent.
- The connection is resolved **by workspace first**, so the only credential
  reachable is the one that workspace connected. An agent cannot act through
  another workspace's account even if a matching grant exists elsewhere.

Approval is independent of the grant. `gmail.send_message` requires a human even
under a wildcard destructive grant.

## Credentials

Berry had no reversible secret handling before this — `personal_api_tokens.secret_hash`
is one-way, which is correct for a value the product never needs back and wrong
for an access token that must be replayed on every call.

`internal/secrets` seals with AES-256-GCM under `INTEGRATION_ENCRYPTION_KEY`.
Sealing is non-deterministic, so two workspaces connecting the same account do
not produce matching ciphertext. Credential columns are `bytea`, so a plaintext
token cannot be written by accident.

**A `Connection` carries no token.** It can be logged, serialised or returned to
an API caller without leaking one; credentials are opened only at the moment of
use.

## OAuth

The provider owns the consent screen. Berry owns proving that a callback belongs
to a flow it started.

- State is 32 bytes from `crypto/rand`, and **only its hash is stored** — a
  leaked table read must not let an attacker finish somebody else's flow.
- Validation checks **reuse before expiry**: a second callback with the same
  state is a replay.
- Redirect URIs are matched against a closed allowlist by scheme, host and path
  prefix **separately**. A prefix match on the whole URL would accept
  `https://berry.example.com.evil.test/` against `https://berry.example.com/`,
  handing the authorisation code to the attacker.
- Plain HTTP is accepted only on loopback.

## Webhooks

A webhook endpoint is an unauthenticated door. Signature verification runs on
the **raw body** before parsing — re-serialising parsed JSON changes key order
and the signature would never match.

| Provider | Scheme |
|---|---|
| GitHub | `X-Hub-Signature-256`, HMAC-SHA256. The legacy SHA-1 header is **refused**, not accepted for compatibility: offering a weaker algorithm lets a forger choose it. |
| Slack | v0 signing. The timestamp is inside the signed string *and* checked for freshness, so a captured request stops being replayable. |
| Linear / Notion | Hex HMAC-SHA256 over the body. |

Comparisons decode first and compare fixed-length bytes; a string compare leaks
length through timing. Every failure returns one error — telling a prober which
part of their forgery was wrong helps them fix it.

## Adding a provider

1. Implement `core.Provider` in `internal/integrations/providers`.
2. Declare tools with honest effects. Anything reaching people is
   `external_side_effect`; anything irreversible is `destructive` and must not
   be `EnabledByDefault` — registration rejects that combination.
3. Point `MCPServer` at the runtime's server for the provider. Pass the
   credential in `Env`, never `Args`: a process argument is visible to anything
   that can list processes.
4. Register it. Nothing else in the application should learn its name.

## Composio, and the long tail

The five here are first-class because they carry Berry's core motion. The long
tail is not worth five files each.

`core.Provider` describes and authorises; it deliberately has **no `Execute`**.
That is what lets a future `ComposioProvider` register alongside these and
participate in the same permission, audit and settings machinery without agents
changing: it would describe its tools and point at Composio's MCP endpoint, and
every consumer would keep asking the registry rather than switching on a name.

## Operator setup

Generate the sealing key once per deployment and keep it stable — rotating it
strands every stored credential:

```
openssl rand -base64 32
```

Then, per provider, register an application and set its client id and secret.
See `.env.example` for the full list. Manual, provider-side steps are listed in
the branch summary; none of them can be automated from Berry.
