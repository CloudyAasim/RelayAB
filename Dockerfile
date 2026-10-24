# Node 24 is in the base image, so the build never downloads it.
#
# Why this file exists at all: the Heroku buildpack Dokku uses installs Node by
# fetching a 58 MB tarball from nodejs.org on every build, with a hard
# 30-second timeout and no resume. Measured on this host:
#
#     curl … node-v24.21.0-linux-x64.tar.gz
#     速度=964914 B/s  用时=60.2s  下载=58088022
#
# Sixty seconds of download for a thirty-second budget. The build fails before
# it compiles a line of project code, which is why one push in nine got through
# and why nothing in the repository could explain the other eight.
#
# A base image pulls the same bytes from Docker Hub — a different route, and a
# layered one, so later builds fetch almost nothing. If that route is slow too,
# the failure names the image instead of filling the log with `curl: (28)` that
# has nothing to do with this project.
#
# Kept deliberately plain: no BuildKit cache mounts and no `pnpm config set`.
# Dokku's builder configuration is not ours to assume, and a flag that silently
# does nothing is worse than the slower thing it was meant to speed up.

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
# package manifests alone, so editing application code does not invalidate the
# install layer — which is the expensive one and the one worth keeping.

FROM node:24.21.0-bookworm-slim AS deps
WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# A ceiling on the build's heap.
#
# The production host has 3.8 GiB of RAM and no swap, and a build on it has
# taken the whole box down three times in one day: the kernel's OOM killer
# reaps sshd and nginx, and the symptom is a site that accepts TCP
# connections and then never answers — not a build that fails.
#
# The build is not supposed to need that much. Measured on this repository
# (Next 15.5.25, 22 routes) the peak resident memory across the whole build
# is 1.65–1.74 GiB with the worker count capped at 2. The cap here is well
# above that, so the build still succeeds — but it puts a ceiling on the part
# that is not predictable (the type-check and the bundler both run inside this
# one process), so a spike becomes a build that fails loudly instead of a box
# that stops answering for the next hour.
#
# 2560 MiB, not 2048: the measured peak is the *whole* build, and this limit
# applies to the main process alone.
#
# The other half of the fix is not in this file: a swap file on the host.
# A ceiling stops the spike; swap keeps the spike from being fatal.
ENV NODE_OPTIONS="--max-old-space-size=2560"

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
# The same node_modules the build used, rather than a prune: pnpm has no
# `prune`, and the multi-stage trick for that needs a package manager that can
# do it. Dev dependencies in the image are a size cost, not a correctness one.

FROM node:24.21.0-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./
COPY --from=build /app/next.config.mjs ./
# The custom server. `pnpm start` runs it, and it is what owns the WebSocket
# surface (`/v1/realtime`) — `next start` alone cannot see the socket an
# upgrade arrives on.
COPY --from=build /app/server.mjs ./server.mjs
# Not needed to resolve `@/*` — the bundler has already inlined it — but
# `next start` reads it, and a config it cannot find is a warning on every boot.
COPY --from=build /app/tsconfig.json ./

# These two are read from the *running* container, by path, at request time —
# not at build time, so nothing else in this file would have pulled them in:
#
#   src/lib/docs/protocol-doc.ts             → docs/模型适配协议/README.md
#     the media adaptation specification, which `get_media_spec_reference`
#     hands to the assistant as text. Without it that tool returns nothing.
#   src/components/docs/SpecCheckReference.tsx → scripts/spec-check.ts
#     the validator's own source, rendered on /admin/docs/spec-check.
#
# The buildpack leaves the whole repository in the image, which is why both
# work today. A multi-stage image that copies only the build output is the kind
# of thing that ships working in development and 500s in production, so they
# are named here instead of discovered there.
COPY --from=build /app/docs ./docs
COPY --from=build /app/scripts ./scripts

# SQLite lives on a Dokku-managed volume at /data, and the image's default path
# (`${cwd}/data`, used when RELAY_DB_PATH is unset) is /app/data. Both exist so
# either configuration has somewhere to put a file.
RUN mkdir -p /data /app/data

# No `USER node`.
#
# The image is built as root but runs as root too, on purpose. Dokku creates the
# volume on the host and bind-mounts it over /data, which means the owner of
# whatever is at /data is the *host's* choice, not this file's — `chown` here
# would be undone by the mount. A `node` user that cannot write the database
# file fails to start, and a gateway that cannot start is worse than a container
# running as root with one SQLite file on it.
#
# If the volume's ownership is ever confirmed to be the container's own user,
# adding `USER node` back is a one-line change. Leaving it out costs very little;
# leaving it in when the mount is root-owned costs the service.
#
# Everything that matters is still in place: the image contains no secrets, the
# process writes only to /data and /tmp, and the dependency tree is exactly what
# pnpm.lock.yaml pinned.

# The port Dokku serves this app on, which for a public site is 443.
#
# Dokku reads EXPOSE out of the Dockerfile and writes nginx's `listen` from it,
# so `EXPOSE 3000` produced a server block listening on 3000 instead — the
# domain then had nothing on 443, every request fell through to the
# `server_name _` default server on this host, and TLS failed with
# "unrecognized name" because that block carries no certificate.
#
# 443 is the *served* port, not the port the process binds: Dokku injects
# PORT=3000, `next start` listens there, and nginx proxies 443 to it. The
# herokuish image this replaced declared nothing, which is why Dokku defaulted
# to 443 and everything worked.
EXPOSE 443

# What Procfile asked for: `pnpm start` → `node server.mjs`.
CMD ["pnpm", "start"]
