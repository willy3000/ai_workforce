# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Multi-stage build.
#
# Stage 1 compiles TypeScript with full devDependencies; stage 2 ships only
# production dependencies and the compiled output. Two reasons this matters for
# this particular platform:
#   - the runtime image contains no compiler and no source, shrinking what an
#     agent-executed command could reach;
#   - `git` IS installed in the runtime image, because cloning and committing to
#     connected repositories is a core capability, not an optional extra.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app

# git: required for clone/branch/commit/push against connected repositories.
# tini: proper PID 1 so SIGTERM reaches Node and shutdown stays graceful.
RUN apk add --no-cache git openssh-client tini ca-certificates

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Workspaces hold cloned repositories; owned by the unprivileged runtime user.
RUN mkdir -p /app/workspaces && chown -R node:node /app
USER node

ENV WORKSPACE_ROOT=/app/workspaces
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
