# Berry's AgentCore Runtime sandbox — the base (Node/TypeScript) template.
#
# This is where an agent's commands run when BERRY_RUNTIME_DRIVER is
# `agentcore-runtime`. It is the analogue of `server-ts/sandbox/docker/Dockerfile`
# (which serves the local `docker` driver), for a managed AgentCore Runtime.
#
# Why a container at all, rather than the managed Code Interpreter: the managed
# interpreter ships no `git` and has no route to github.com, both verified
# against the live service. A run clones and pushes through its session, so
# neither is optional. Owning the image is what makes those possible.
#
# Why a *family* of these: the repository a run works in decides the toolchain.
# This template carries Node and pnpm because that is Berry's own stack; a PHP
# or Python repository wants its own image. Keep `server.mjs` shared and vary
# only the toolchain layer, so a new language is a new Dockerfile and not a new
# contract to re-learn.
#
# Platform is ARM64 — required by AgentCore Runtime, and native on Apple
# Silicon, so this builds without emulation.
FROM --platform=linux/arm64 node:22-slim

# The toolchain layer. Everything an agent's commands may reach for:
#   git          — a run clones and pushes through its own session
#   ca-certificates — TLS to github.com and to a registry
#   openssh-client  — git over ssh, when a repository is not cloned over https
#   curl, tar, unzip, gcc/g++/make — what a dependency install commonly needs
#      to build a native module; absent, `pnpm install` fails deep in a
#      postinstall script rather than at the top with a clear message.
#   ffmpeg       — the one media tool: a run that renders a clip and narrates
#      it has to be able to put the two together, and nothing else here can.
RUN apt-get update \
   && apt-get install -y --no-install-recommends \
      git \
      ffmpeg \
      ca-certificates \
      openssh-client \
      curl \
      tar \
      unzip \
      gcc \
      g++ \
      make \
      python3 \
   && rm -rf /var/lib/apt/lists/*

# pnpm through corepack, pinned to the version the workspace uses, so a run's
# install resolves the same lockfile Berry's own CI does.
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

# Where a run's working tree lives. A persistent filesystem can be mounted here
# through the runtime's `filesystemConfigurations`, which is what lets a
# checkout, its installed packages and its build artifacts survive a session
# stop rather than being cloned again.
RUN mkdir -p /mnt/workspace
WORKDIR /mnt/workspace

# The contract server. Copied last because it changes more often than the
# toolchain above, and this keeps the expensive layer cached.
COPY server.mjs /opt/berry/server.mjs

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# No build step and no dependencies: the server is one dependency-free file.
CMD ["node", "/opt/berry/server.mjs"]
