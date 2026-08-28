# The runtime service.
#
# It holds the Docker socket so Berry's API does not have to: talking to the
# daemon is root-equivalent on the host, and the API container runs read-only
# with every capability dropped. This one is small enough to read end to end.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
# No lockfile and no install: the service depends on hono and its node server,
# both of which are pure JavaScript with no build step. Installing here rather
# than copying a node_modules tree keeps the image reproducible.
RUN npm install --omit=dev --no-package-lock

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV RUNTIME_ADDR=0.0.0.0:4300
EXPOSE 4300

CMD ["node", "--experimental-strip-types", "src/index.ts"]
