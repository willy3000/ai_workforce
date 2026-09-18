# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Operator console image.
#
# Multi-stage, mirroring the backend: stage 1 builds with devDependencies,
# stage 2 ships Next's traced standalone output and nothing else. The console
# holds the platform API key and the session secret in its environment, so the
# runtime image deliberately contains no source, no compiler and no shell
# tooling beyond what Node needs.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
# Build-time env is not baked in: every value is read at request time by server
# code, which is what keeps credentials out of the client bundle.
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache tini
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `standalone` emits a self-contained server plus the traced dependency subset.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3   CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
