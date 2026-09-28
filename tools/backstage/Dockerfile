# syntax=docker/dockerfile:1
#
# The demo Backstage (tools/backstage/README.md): Backstage 1.55.2, the app in
# ./app, this folder's app-config.yaml, and the demo SI registered through the
# Location init platform writes. Built by compose.yml, which hands it the demo
# SI as the named context `si-demo`; by hand, from the repository's root:
#
#   docker build tools/backstage --build-context si-demo=fixtures/si-demo -t idp-agent-demo-backstage:1.55.2

# Node 24, the version create-app 0.9.2 (Backstage 1.55.2) targets, pinned by
# tag and digest. The build and the run share it, so better-sqlite3's native
# module is built for the libc it runs on.
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe

FROM ${NODE_IMAGE} AS build
# better-sqlite3 compiles from source when no prebuilt binary fits.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 g++ make \
 && rm -rf /var/lib/apt/lists/*
# Yarn 4.13.0, as package.json's packageManager names it, through Node's
# corepack, which refuses a download whose sha512 is not the one named there.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /build

# The manifests and the lockfile first, so a change to the sources does not
# download 2,000 packages again. --immutable: the lockfile is committed, and a
# build that would change it fails instead.
COPY app/package.json app/yarn.lock app/.yarnrc.yml app/backstage.json app/tsconfig.json ./
COPY app/packages/app/package.json packages/app/
COPY app/packages/backend/package.json packages/backend/
RUN --mount=type=cache,target=/root/.yarn/berry/cache,sharing=locked \
    yarn install --immutable

# The backend's build builds the frontend first (a workspace dependency) and
# packs both: dist/skeleton.tar.gz (the manifests) and dist/bundle.tar.gz.
# The frontend build reads app-config.yaml for what the browser sees; the
# token is not among it, and a placeholder satisfies the substitution.
COPY app/packages packages
COPY app-config.yaml ./
RUN IDPA_CATALOG_TOKEN=build-time-placeholder yarn workspace backend build

# The production dependencies alone, from the skeleton: the frontend is
# `bundled`, so none of its dependencies are installed.
WORKDIR /prod
RUN cp /build/package.json /build/yarn.lock /build/.yarnrc.yml /build/backstage.json ./ \
 && tar xzf /build/packages/backend/dist/skeleton.tar.gz
RUN --mount=type=cache,target=/root/.yarn/berry/cache,sharing=locked \
    yarn workspaces focus --all --production \
 && tar xzf /build/packages/backend/dist/bundle.tar.gz \
 && rm -rf .yarn

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# Everything under /app is root's and only readable by node, which runs it:
# the backend writes nothing there, and the configuration cannot be changed
# from inside.
COPY --from=build /prod ./
# The demo SI as it sits in the repository, witnesses included, and beside it
# the registration renderRegistration writes for a directory named si-demo
# (tests/unit/demo-backstage.test.ts holds the file to that function's bytes).
COPY --from=si-demo . ./si-demo/
COPY registration/catalog-info.yaml ./si-demo/catalog-info.yaml
COPY org.yaml ./org/org.yaml
COPY app-config.yaml ./
USER node
EXPOSE 7007
CMD ["node", "packages/backend", "--config", "app-config.yaml"]
