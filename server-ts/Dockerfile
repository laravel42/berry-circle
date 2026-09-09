# The Berry product server.
#
# No build step: Node strips the types at load, so the image runs the same
# sources development runs. There is no transpiled artefact that can diverge
# from what was tested.
FROM node:22-alpine

WORKDIR /app

# pnpm is the project's package manager. Pinned through corepack so the image
# resolves the same version the workspace uses rather than whatever npm ships.
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate

# Dependencies first, so a source change does not reinstall them. The
# standalone lockfile is committed alongside package.json; --frozen-lockfile
# refuses to drift from it, the same guarantee `npm ci` gave.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-workspace

COPY tsconfig.json ./
COPY src ./src
# The schema. Shipped in the image because the migrator runs from it at boot,
# and a server whose migrations live somewhere else can start against a
# database it does not match.
COPY migrations ./migrations

ENV NODE_ENV=production
ENV API_ADDR=0.0.0.0:4000
EXPOSE 4000

# --experimental-strip-types is what lets the .ts sources run directly. It is
# the same flag development uses, so there is no build to diverge from.
CMD ["node", "--experimental-strip-types", "src/index.ts"]
