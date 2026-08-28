# Berry runtime

Where an agent's commands run, on the operator's own Docker daemon.

One disposable container per Berry run, named for the run. It answers the same
wire contract as `runtime-worker/` — [`PROTOCOL.md`](../runtime-worker/PROTOCOL.md)
is normative for both — so Berry cannot tell which substrate it is talking to,
and the driver in `server-ts/src/execution/http.ts` is unchanged between them.

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
| `src/app.ts` | The routes, separated from the daemon so auth is testable |
| `src/docker.ts` | The Engine API — seven calls, written directly |
| `src/demux.ts` | Docker's multiplexed exec stream, which is how stdout and stderr stay apart |
| `src/config.ts` | Every limit that bounds a container running code an agent wrote |
| `sandbox/Dockerfile` | The image runs happen in: node 22, pnpm, git |

## Running it

```sh
pnpm install
pnpm --filter @berry/runtime typecheck
pnpm --filter @berry/runtime test      # routes, auth and framing, no daemon needed
```

Against a real daemon:

```sh
docker build -t berry-sandbox:local runtime/sandbox

cd runtime
BERRY_RUNTIME_TOKEN=$(openssl rand -base64 32) \
BERRY_SANDBOX_IMAGE=berry-sandbox:local \
  pnpm dev
```

In the Compose stack it comes up as `runtime`, and `sandbox-image` builds the
run image before it starts.

## What bounds a run

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
protect them from. Hosting other people's agents is a different problem and
wants `runtime-worker/`, or a VM boundary.

## Not built yet

- **Nothing calls this from a run.** The seam and both substrates exist; the
  `run_command` agent tool is the next increment.
- **No resume.** Events carry `seq`, so the format is ready, but a dropped
  connection loses the tail of the log rather than resuming.
- **No repository checkout.** `git` is in the sandbox image; nothing clones
  with it until the GitHub phase.
