# Berry's AgentCore Runtime image: the agent loop and its tools (ADR-0014).
#
# Built from the server-ts context so it runs the same sources the server's
# tests exercise, under --experimental-strip-types, with no build step:
#   docker build -f sandbox/agentcore/Dockerfile -t berry-agent-runtime server-ts
# What it copies is pinned by src/agents/runtime/container/closure.test.ts.
#
# Session lifecycle (spec 2.2a): apply once per deploy, not at every boot —
# UpdateAgentRuntime creates a new runtime version each time it runs:
#   aws bedrock-agentcore-control update-agent-runtime --agent-runtime-id <id> \
#     --lifecycle-configuration idleRuntimeSessionTimeout=3600,maxLifetime=28800 \
#     --agent-runtime-artifact file://artifact.json --role-arn <role> \
#     --network-configuration networkMode=PUBLIC
# A profile's idle timeout on a registered runtime is applied by Berry when the
# profile is saved (src/runtime/runtime-control.ts).
#
# ARM64 is required by AgentCore Runtime. Local x86 hosts can build with
# --build-arg BERRY_RUNTIME_PLATFORM=linux/amd64 (Compose does via env).
ARG BERRY_RUNTIME_PLATFORM=linux/arm64
FROM --platform=${BERRY_RUNTIME_PLATFORM} node:22-slim

# The toolchain an agent's commands reach for: git to clone and push, ffmpeg for
# media, a compiler for native modules, python3 for common scripts.
RUN apt-get update \
   && apt-get install -y --no-install-recommends \
      git ffmpeg ca-certificates openssh-client curl tar unzip gcc g++ make python3 \
   && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

WORKDIR /opt/berry
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-workspace
COPY tsconfig.json ./
COPY src/agents ./src/agents
COPY src/execution ./src/execution
COPY src/runtime/envelope.ts src/runtime/lifecycle.ts ./src/runtime/
# Delivery signs its commits with the co-author trailer (GitHub parity).
COPY src/scm/commit-trailer.ts ./src/scm/

# Session workspaces. A persistent filesystem can be mounted here through the
# runtime's filesystemConfigurations so a checkout survives a session stop.
RUN mkdir -p /mnt/workspace
WORKDIR /mnt/workspace

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "/opt/berry/src/agents/runtime/container/main.ts"]
