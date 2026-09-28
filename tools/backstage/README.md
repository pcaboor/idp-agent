# The demo Backstage

A real Backstage, in Docker, holding the demo SI, so that an evaluator sees the catalogue's
pages and `idpa` reading the same catalogue. Optional: it needs Docker, it is never part of
CI, and `pnpm test` never starts it. Installing a company's Backstage stays out of this
tool's scope ([`docs/adopting-backstage.md`](../../docs/adopting-backstage.md)); this one
exists because an evaluator will not install one (the owner's decisions of 2026-09-27 and
2026-09-28, [`docs/roadmap.md`](../../docs/roadmap.md)).

```console
$ pnpm build && pnpm demo:backstage:docker     # build, start, wait, run idpa against it, stop
$ pnpm backstage:up                            # or leave it running: http://127.0.0.1:7007
$ env -u IDP_REPO IDP_BACKSTAGE_URL=http://127.0.0.1:7007/api/catalog \
    IDP_BACKSTAGE_TOKEN=idpa-demo-read-only-token idpa relations mysql-prod-01 --impacts
$ pnpm backstage:down
$ pnpm backstage:clean                         # stop it and remove its image
```

Open `http://127.0.0.1:7007`, choose **Enter** as a guest, and the catalogue is the landing
page: five Components, and under the Resource kind every database, cache, API and right of
the demo SI. An entity's page draws its relations — `billing-db-prod` depends on
`mysql-prod-01` and the two rights over it depend on it — and a team's page lists what it
owns.

## What is here

| File | What it is |
|---|---|
| `compose.yml` | the one service, `idp-agent-demo-backstage`, published on `127.0.0.1:7007` only |
| `Dockerfile` | two stages on `node:24.21.0-trixie-slim`, pinned by tag and digest |
| `app/` | the Backstage app: a frontend and a backend package, their manifests and the lockfile |
| `app-config.yaml` | the whole configuration; its registration and token are the adopting page's |
| `registration/catalog-info.yaml` | the Location `init platform` writes, for a directory named `si-demo` |
| `org.yaml` | the four teams the demo SI names as owners |

## The choices, and why

**Our own image, not a community one** (the owner's decision, 2026-09-28). What runs is what
this folder says, at a version it names, and nothing else: no plugin the demo does not show,
no configuration nobody here wrote.

**A committed minimal app, not `npx @backstage/create-app` at build time.** create-app's
template is a whole portal — scaffolder, TechDocs, search, Kubernetes, notifications, signals,
MCP actions — and generating it in the build, then pruning it, would put an unreviewed
generator and an unreviewed patch between this folder and the image. The app here is eleven
files, the lockfile among them, derived from create-app 0.9.2's `default-app` (Backstage
**1.55.2**), and read like any other code:

- the frontend (`packages/app`), Backstage's new frontend system: the catalogue, the
  organisation pages and the catalogue graph, and the default sign-in page, which offers
  guest;
- the backend (`packages/backend`): four plugins — `app` (serves the frontend on the backend's
  port), `auth` and its guest module, and `catalog`.

**Every version exact, and the lockfile committed.** Each `@backstage/*` dependency is the
version the 1.55.2 release manifest names, `backstage.json` says 1.55.2, Yarn is 4.13.0
through corepack, its sha512 named beside the version in `packageManager` so that corepack
refuses any other binary, and `yarn install --immutable` refuses a build that would change
`yarn.lock`. The first build showed why the lockfile matters: `@yarnpkg/core` 4.9.2, published
four days earlier and reached by `@backstage/cli` through a caret range, declares a
dependency on a patch file of Yarn's own repository, so no install could resolve it. The root
`package.json` pins it to 4.9.1 (`resolutions`), and with the lockfile the next release of any
of the 2,080 packages changes nothing here. `.yarnrc.yml` keeps create-app's three-day age gate
for when the lockfile is regenerated.

**Two stages.** The build stage has Python and a compiler, for `better-sqlite3`'s native
module; it installs, builds the frontend and the backend (`backstage-cli package build`,
which packs both), then installs the production dependencies alone from the build's skeleton.
The run stage is the same Node image with that and nothing else, running as `node`: every
file under `/app` is root's and only readable by it, and `compose.yml` drops every capability
and sets `no-new-privileges`, so the image's setuid binaries give nothing.

**The demo SI, unchanged, registered through slice 0's Location.** `compose.yml` hands the
build `fixtures/si-demo` as a named context, and the image holds it at `/app/si-demo`, dotfiles
included. Beside it is `registration/catalog-info.yaml`, which is `renderRegistration('si-demo')`
— the bytes `init platform` writes for a repository of that name; `tests/unit/demo-backstage.test.ts`
fails when they differ, and says how to regenerate them. The app-config registers that one
file, as the adopting page registers a repository, with `type: file` because the repository
is in the image rather than on a forge. Backstage's file reader resolves the relative targets
against the Location's own path and expands each glob with `glob`, which matches no dotfile:
all 33 entities are ingested and no witness is.

**The rules, as the adopting page writes them.** The registration's entry allows `Location,
Component, API, Resource`, and there is no `catalog.rules`. Backstage checks an entity against
the rules of its **origin** location (`DefaultCatalogProcessingOrchestrator`,
`CatalogRules.ts` in `plugin-catalog-backend` 4.0.0), which for everything the Location's
targets bring in is this entry: the 28 Resources are admitted, and the page is right.

**The teams as organisation data of their own.** A company's Groups come from its
organisation, never from the declarations repository, so `org.yaml` is a second location,
allowed `Group` and nothing else. `idpa` counts them as not modelled.

**The read token, the adopting page's.** `backend.auth.externalAccess` is the page's block, a
static token restricted to `catalog.entity.read`. Its value is `IDPA_CATALOG_TOKEN`, whose
default in `compose.yml`, `idpa-demo-read-only-token`, is a demo value, public here and never
a secret; set the variable to change it. Without a token the catalogue answers 401, and with
this one a refresh or a new location is refused, 403.

**127.0.0.1 only, one port.** The backend serves the frontend too, so `7007` is the only port,
published on the loopback interface: nothing listens on the LAN, and `idpa`'s rule lets
`http:` reach a loopback catalogue. Backstage warns at start that `backend.baseUrl` is a local
address in production; for this demo that is the point.

**Guest sign-in, a demo convenience.** Backstage refuses the guest provider outside
development unless told otherwise, which `app-config.yaml` does; there is no permission
policy, so a guest may do what any signed-in user may — refresh entities, register a location,
which the backend then fetches — and a guest token takes one unauthenticated request. The
loopback keeps the LAN out, not the rest of this machine: any local process can do it, and so
can a web page whose host name rebinds to 127.0.0.1, since the backend accepts any `Host`.
For a demo, on a machine's loopback, that is acceptable while you are looking at it; stop the
demo with `pnpm backstage:down` when you are done, and do not leave `backstage:up` running
while you browse. Nowhere else is it acceptable.

**SQLite in memory.** The catalogue is rebuilt from the files at every start, within seconds,
and the demo needs no database service.

## What a real Backstage serves that the fake does not

`tools/fake-backstage.ts` stays what the suite and `pnpm demo:backstage` read. Against this
Backstage, `relations mysql-prod-01 --impacts`, `show`, `graph` and `relations --to` printed
what `--demo` prints, byte for byte, with no change to the provider. What differed, and why
none of it reached an answer:

- **Relations the file does not declare.** Backstage stitches the inverse of every relation
  onto its target: `billing-db-prod` is served `dependencyOf` the two rights over it, which its
  own file never states. The fake emits an entity's own relations only. The pre-pass drops
  `relations` whole, and `tests/contract/backstage-page.test.ts` proves it on the recorded page.
- **`file:` locations, and a distinct origin.** `managed-by-location` is
  `file:/app/si-demo/<path>`, and `managed-by-origin-location` is the registration, where the
  fake sets both to the file's `url:`. The provider orders by the first, and the paths sort as
  the fixture's files do; it does not read the second.
- **Three Locations.** The registration, and one `generated-…` Location per
  `catalog.locations` entry. They and the four Groups are read as references and counted:
  `40 entities: 33 read, 7 not modelled`.
- **What a refused read says.** A missing token is `AuthenticationError`, "Missing
  credentials"; the provider quotes no body, so its line is the fake's.

## Removing it

`pnpm backstage:down` removes the container and its network and keeps the image (539 MB), so
the next `up` starts in seconds. `pnpm backstage:clean` removes the image too. The build
leaves its layers and the Yarn cache in Docker's build cache, about 2.5 GB after a cold
build; `docker builder prune` reclaims it, and removes every other unused build cache on the
machine with it (`docker buildx du` shows what it would take).

## Moving the version

Take the next release's manifest (`https://versions.backstage.io/v1/releases/<version>/manifest.json`),
set every `@backstage/*` version in `app/` and `backstage.json` from it, compare `app/` with
that release's create-app `default-app` template, regenerate `yarn.lock` in a Node container
(`yarn install --mode=update-lockfile`), move the image tag in `compose.yml`, then run
`pnpm build && pnpm demo:backstage:docker --record`, which writes the contract fixture under
the new version's name, and delete the old one: `tests/contract/backstage-page.test.ts` reads
the version from `backstage.json`.

## Measured

On an arm64 Mac with Docker Desktop, 2026-09-28: the first build took 2 min 50 s with the Node
image already pulled (about 1 min 5 s of it installing 2,080 packages), the image is 539 MB,
the backend was healthy 6 to 11 s after `up`, and the catalogue held the whole demo SI on the
first poll after that.
