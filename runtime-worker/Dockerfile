# The image every agent run gets.
#
# Kept deliberately small: the image is pulled on a cold start, so every tool
# added here is latency on the first run of the day. Anything a single project
# needs and others do not belongs in that project's own setup step, run inside
# the sandbox, not baked in here.
FROM docker.io/cloudflare/sandbox:0.7.0

# git is not in the base image and is the one addition that is not optional —
# a run that cannot clone a repository or open a branch cannot deliver work.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The base image ships Node 20. Berry's own projects are on 22+, and a test run
# on the wrong major is a failure that looks like the agent's fault.
RUN npm install -g n \
 && n 22 \
 && npm install -g pnpm@10.12.1 \
 && npm cache clean --force

# Never prompt, and never open an editor: a command that blocks waiting for
# input holds the container until its timeout with no output explaining why.
ENV GIT_TERMINAL_PROMPT=0
ENV GIT_EDITOR=true
ENV CI=true

# Required for local development port exposure.
EXPOSE 8080
