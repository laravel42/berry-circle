# The image an agent's commands run in.
#
# Separate from the runtime service's own image: this one is disposable and
# per-run, and every tool added here is latency on the first run after a pull.
# Anything one project needs and others do not belongs in that project's setup
# step, run inside the sandbox, not baked in here.
FROM node:22-alpine

# git is the one addition that is not optional — a run that cannot clone a
# repository or open a branch cannot deliver work. The rest is what a
# JavaScript project needs to install and build.
# ffmpeg is the one media tool: a run that renders a clip and narrates it
# has to be able to put the two together, and nothing else on the image can.
RUN apk add --no-cache git ca-certificates openssh-client bash ffmpeg \
 && corepack enable \
 && corepack prepare pnpm@10.12.1 --activate

# Never prompt and never open an editor: a command that blocks waiting for
# input holds the container until its timeout with nothing explaining why.
ENV GIT_TERMINAL_PROMPT=0
ENV GIT_EDITOR=true
ENV CI=true

WORKDIR /workspace

# The container is a place to exec into, not a process in its own right. The
# runtime service overrides this, but a sensible default means `docker run` on
# the image behaves the same way.
CMD ["tail", "-f", "/dev/null"]
