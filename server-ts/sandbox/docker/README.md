# Berry runtime service

Where an agent's commands run, on the operator's own Docker daemon.

One disposable container per Berry run, named for the run. It answers a small
HTTP wire contract that the `docker` execution driver
(`server-ts/src/execution/http.ts`) speaks, so a run's ledger is unaware of
where work happened.

This source lives under `server-ts/sandbox/docker/runtime/` — beside the image
it drives, and beside `sandbox/agentcore/` for the managed substrate — in the
server-ts package so there is one package to
reason about, but it is still shipped as its own image
(`server-ts/sandbox/docker/Dockerfile.runtime`) and run as its own Compose service — the
Docker socket stays out of `berry-api`.

## Why it is a separate service

Reaching the Docker socket is root-equivalent on the host, and Berry's API
container runs read-only with every capability dropped. Putting the socket here
keeps that posture intact: the API talks to this over HTTP with a shared
secret, exactly as it would talk to a remote substrate.

`scripts/check-compose-config.py` enforces that only this service mounts the
socket. That check fails if anything else picks it up.

## Layout

| File | What |
|---|---|
| `runtime/app.ts` | The routes, separated from the daemon so auth is testable |
| `runtime/docker.ts` | The Engine API — seven calls, written directly |
| `runtime/demux.ts` | Docker's multiplexed exec stream, which is how stdout and stderr stay apart |
| `runtime/config.ts` | Every limit that bounds a container running code an agent wrote |
| `Dockerfile` | The image runs happen in: node 22, pnpm, git, ffmpeg |
| `Dockerfile.runtime` | The image this service ships as |

## Running it

Types and tests come with the rest of the server:

```sh
pnpm typecheck:server
pnpm test:server        # includes the runtime routes, auth and framing, no daemon needed
```

In the Compose stack it comes up as `runtime`, and `sandbox-image` builds the
run image before it starts.

## Substrate choice

`BERRY_RUNTIME_DRIVER` selects where an agent's commands run:

- `docker` — this service, a disposable container per run on the host daemon.
  The self-hosted path: no AWS account required.
- `agentcore-runtime` — a deployed AWS Bedrock AgentCore Runtime, invoked by
  ARN, running Berry's own image from `server-ts/sandbox/agentcore/`. Carries
  git, node and pnpm, with public egress, so a run can clone and push.
- `agentcore` — an AgentCore Code Interpreter session. **Not usable for a run
  that touches a repository:** the managed interpreter ships no `git` and has no
  route to github.com (both verified against the live service). It needs a
  custom Code Interpreter with those allowed before it is a real option.

## What bounds a run (docker driver)

Every default is deliberately modest: a runaway run must not be able to take
the host down because nothing was set.

| Variable | Default | Why |
|---|---|---|
| `BERRY_SANDBOX_MEMORY_MB` | `2048` | Enough to install a dependency tree, not enough to starve the host |
| `BERRY_SANDBOX_CPUS` | `1` | |
| `BERRY_SANDBOX_PIDS` | `512` | A fork bomb is the cheapest way for generated code to take a host down |
| `BERRY_SANDBOX_NETWORK` | `bridge` | Agents install packages and clone repositories. `none` turns that off |
| `BERRY_SANDBOX_MAX_CONTAINERS` | `8` | Over the ceiling the service answers 429, which Berry retries rather than failing the run |

Containers also run with `CapDrop: ALL` and `no-new-privileges`.

## What this is not

**It is not a boundary against untrusted code.** Containers share the host
kernel. For a self-hosted Berry that is the right trade — the agent runs code
the team already trusts, on their own machine, and there is no other tenant to
protect them from. Hosting other people's agents wants a managed substrate
(`agentcore` / `agentcore-runtime`) or a VM boundary.
