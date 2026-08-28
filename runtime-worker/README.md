# Berry runtime worker

Where an agent's commands run, for the hosted workspace.

A Cloudflare Worker fronting a Sandbox Durable Object: one sandbox per Berry
run, addressed by the run's own id. It exists because Berry promises "isolated
workspace, streamed log, recorded commands, exit codes" and had none of them.

- [`PROTOCOL.md`](PROTOCOL.md) is the wire contract, and is normative.
- `src/app.ts` holds the routes, separated from the bindings so they can be
  tested without a container.
- `src/translate.ts` maps the Sandbox SDK's event vocabulary onto Berry's.
  This is the file that lets a second driver exist.

## This is one of two drivers

Cloudflare Containers cannot be self-hosted — they need a Workers **Paid** plan
and Cloudflare's platform. Berry also ships MIT and claims `docker compose up
-d`, so a local container driver has to satisfy the same contract for
self-hosted deployments. Nothing above `server-ts/src/execution/driver.ts`
knows which one it is talking to, and it must stay that way.

## Running it

```sh
pnpm install
pnpm --filter @berry/runtime-worker typecheck
pnpm --filter @berry/runtime-worker test      # routes, auth and translation, no container
```

Local development needs Docker running, because the container image is built
and run locally:

```sh
docker info                                   # must succeed
pnpm --filter @berry/runtime-worker dev       # wrangler dev, on :8787
```

## Deploying

```sh
pnpm --filter @berry/runtime-worker deploy
wrangler secret put BERRY_RUNTIME_TOKEN       # generate with: openssl rand -base64 32
```

Then point Berry at it:

```sh
BERRY_RUNTIME_DRIVER=cloudflare
BERRY_RUNTIME_URL=https://berry-runtime.<subdomain>.workers.dev
BERRY_RUNTIME_TOKEN=<the same secret>
```

Berry refuses a plaintext `BERRY_RUNTIME_URL` outside loopback: the token is on
every request.

## What is not built yet

- **The `run_command` tool.** Nothing calls this worker from an agent run yet;
  the seam is in place and the tool is the next increment.
- **Resume from a cursor.** Events carry `seq`, so the format is ready, but a
  dropped connection currently loses the tail of the log rather than resuming.
  That is the `RunSession` Durable Object in phase 4.
- **Repository checkout.** `git` is in the image; nothing clones with it until
  the GitHub phase lands.
