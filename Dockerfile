# Debian slim (glibc) rather than Alpine: the zeromq native bindings have
# far more reliable prebuilt binaries for glibc than for musl across both
# amd64 and arm64, which keeps this buildable without compiling libzmq
# from source in CI.

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Only needed as a fallback if a native dependency has no prebuilt binary
# for the target platform (e.g. under qemu emulation during multi-arch CI).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# `npm ci` rather than `npm install`, and no glob on the lockfile: this image
# is published under a tag+digest that the app store pins as "exactly this
# artifact", so the build has to actually be reproducible. The old
# `package-lock.json*` glob meant a missing lockfile still produced a happy
# build from whatever the registry served that day.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY package.json ./

# The stock node:* image already ships a non-root "node" user at uid/gid
# 1000, matching what Umbrel expects to own ${APP_DATA_DIR}.
USER node

# Overridden per compose service (dashboard-server.js / peer-profiler.js /
# relay-profiler.js / stratum-race.js) via `command:`.
CMD ["node", "src/dashboard-server.js"]
