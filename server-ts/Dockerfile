# The TypeScript product server, run alongside Go during the migration.
#
# No build step: Node strips the types at load. That keeps the image close to
# what runs in development, which matters while the two servers are being
# compared response by response — a transpiled artefact would be one more
# difference to rule out when they disagree.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV API_ADDR=0.0.0.0:4100
EXPOSE 4100

# --experimental-strip-types is what lets the .ts sources run directly. It is
# the same flag development uses, so there is no build to diverge from.
CMD ["node", "--experimental-strip-types", "src/index.ts"]
