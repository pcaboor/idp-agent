# Adopting Backstage later

A company without Backstage loses nothing this tool promises. The declarations repository
`init platform` creates is the source of truth, and every command — questions, relations,
plans, `validate` — runs on its files from the first day. Installing, hosting and operating
a Backstage is a platform project of its own, and not this tool's: Backstage ships its
installer (`npx @backstage/create-app`), and this page starts where that one ends.

What the tool owes such a company is that adopting Backstage later costs **one
registration, not a migration** (the owner's decision of 2026-09-27; the
[`backstage-http` design note](backstage-http-brief.md), § 2 and slice 0). The repository is
already in Backstage's format, `validate` holds every file to what Backstage accepts, and
`init platform` wrote the one file Backstage needs to find the rest.

## What `init platform` already wrote

`catalog-info.yaml`, at the root of the repository, is its **Backstage registration**:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Location
metadata:
  name: platform-iac
  description: Every entity this declarations repository keeps under catalog/, components/ and dependencies/.
spec:
  presence: optional
  targets:
    - ./catalog/**/*.yml
    - ./catalog/**/*.yaml
    - ./components/**/*.yml
    - ./components/**/*.yaml
    - ./dependencies/**/*.yml
    - ./dependencies/**/*.yaml
```

- **The targets are built from the path registry**, never written by hand: one pair per
  folder the registry files entities under. A resource type added under a new folder adds
  its target to every repository scaffolded afterwards. `.yml` is what the engine writes;
  `.yaml` is what a person may add, and `validate` reads both, so Backstage ingests what
  `validate` checked. `components/` is registered too: it is where a repository that keeps
  its Components centrally keeps them — the demo SI does, and it is stage 8's default for a
  new Component — although no operation files one there yet. `presence: optional` makes an
  empty or missing folder no error.
- **The name** is the directory's, in Backstage's name grammar: lower case, every run of
  anything but a letter or a digit one `-`, 63 characters at most; `declarations` when the
  directory's name leaves nothing.
- **No `spec.type`.** Backstage resolves a relative target against the Location file only
  when the Location's type is the registration's, and this file cannot know how it will be
  registered: it states none and inherits it.
- **`presence: optional`.** A glob matching nothing is an error on the Location otherwise,
  and a fresh repository has nothing in any folder. The witnesses are never ingested: they
  are dotfiles, and no glob matches a dotfile.

`validate` recognises the file and counts it in silence. It fails the build when Backstage
would refuse or ignore the Location, or read outside the repository — no target, an absolute
URL or path, a target climbing out with `..`, a stated `spec.type`, a kind not written
`Location`, another apiVersion, a name Backstage refuses, a `presence` it does not define —
and on one house rule: every target starts with `./`, so that it reads the same under a
`url` and a `file` registration. It warns, naming them, when no target reaches one of the
registry's folders, because Backstage would then ingest nothing filed there. A `kind:
Location` anywhere else is set aside like any kind this tool does not model, with a warning;
Backstage, though, follows one filed under the registered folders, targets and all, so keep
Locations out of them.

**A repository that already had a root `catalog-info.yaml`** keeps it, byte for byte, as
`init platform` keeps every file. When that file does not register every folder, `init
platform` says so on stderr and prints the Location it needs, to be added as a document of
its own (or in place of the Location it holds).

## Register the repository

One entry in the `app-config.yaml` of the company's Backstage, naming the registration on
the default branch.

GitHub:

```yaml
catalog:
  locations:
    - type: url
      target: https://github.com/acme/platform-iac/blob/main/catalog-info.yaml
      rules:
        - allow: [Location, Component, API, Resource]
```

GitLab:

```yaml
catalog:
  locations:
    - type: url
      target: https://gitlab.com/acme/platform-iac/-/blob/main/catalog-info.yaml
      rules:
        - allow: [Location, Component, API, Resource]
```

**The `rules` are not optional.** Without `catalog.rules`, Backstage lets a registered
location bring in Components, APIs and Locations and nothing else, so every database, cache
and access of the repository — all `kind: Resource` — would be refused. The rule above
allows them from this one location. A repository that also holds the company's Groups,
Systems or Domains adds those kinds to the list.

Registering the same URL through Backstage's *Register an existing component* page works
too, but that registration is held to the global `catalog.rules` alone, and the Resources
are refused unless those allow them.

Backstage reads the repository through its **integration** for the forge, which a Backstage
already reading repositories has. For a private repository it needs a token that can read
this one:

```yaml
integrations:
  github:
    - host: github.com
      token: ${GITHUB_TOKEN}
  gitlab:
    - host: gitlab.com
      token: ${GITLAB_TOKEN}
```

A self-hosted GitHub Enterprise or GitLab is the same entry with its own `host`.

Once the backend has read the location, the Location appears in the catalogue, and the
entities follow on its processing loop, usually within minutes. A target Backstage could not
read is reported on the Location entity's page.

### What was verified, and where

Against Backstage's source, `backstage/backstage` at `43e352a` (2026-09-25), the version the
design note describes:

- **Relative targets.** `plugins/catalog-backend/src/processing/util.ts`, `toAbsoluteUrl`:
  a target is resolved against the Location file's URL through the integration's
  `resolveUrl`, and left as written when the Location states a type other than the one that
  read it.
- **Globs.** `packages/backend-defaults/src/entrypoints/urlReader/lib/GithubUrlReader.ts`
  and `GitlabUrlReader.ts`, `search`: a path holding `*` or `?` is a search. GitHub's lists the
  repository's tree at the branch's commit and filters it with `minimatch`; GitLab's reads
  the tree under the glob's fixed part — the segments before the first holding `*` or `?` —
  and filters it with `minimatch`. `**` matches any depth, and neither matches a dotfile.
  That fixed part is why the targets use no brace expansion.
- **Presence.** `plugins/catalog-backend/src/processors/UrlReaderProcessor.ts`,
  `readLocation`: a search matching no file is a not-found error unless the location is
  optional.
- **Rules.** `plugins/catalog-backend/src/ingestion/CatalogRules.ts`: the default rules allow
  `Component`, `API` and `Location`; a `catalog.locations` entry's own `rules` apply to
  everything that location brings in.

Bitbucket, Azure DevOps and Gerrit were not verified. Where a forge's reader does not search,
a target with a glob reads nothing, and the Location lists the files one by one instead.

## The read token for `idpa`

Registering the repository serves Backstage's users. Reading the living catalogue from
`idpa` is a separate provider, `backstage-http`, which is **designed and not built yet**
([the design note](backstage-http-brief.md), slice 1). When it lands, it reads one bearer
token from `IDP_BACKSTAGE_TOKEN` and nowhere else. The token the design note recommends is a
static external-access token restricted to entity reads, on the operator's side:

```yaml
# the company Backstage's app-config
backend:
  auth:
    externalAccess:
      - type: static
        options:
          token: ${IDPA_CATALOG_TOKEN}
          subject: idp-agent
        accessRestrictions:
          - plugin: catalog
            permission: catalog.entity.read
```

Two consequences to know before issuing it. The organisation's permission policy is not
consulted for a service principal, so every holder of the token sees the whole catalogue.
And without `accessRestrictions` the same token could register, refresh and delete: read-only
is a setting on the server, which the tool cannot check from outside. The alternative, on a
Backstage 1.53 or later with the CLI login enabled, is each person's own token
(`backstage-cli auth print-token`), to which the permission policy applies.

## What a person gains

In Backstage, from the registration alone:

- every resource and every access of the repository, browsable and searchable beside the
  services, with its owner;
- the relations Backstage draws from `dependsOn` and `dependencyOf`, so a service's page
  shows what it reaches and a database's page who reaches it;
- the Components declared in the services' own repositories linked to the rights that
  name them.

With the `backstage-http` provider, once built: `idpa` answering questions and relations
about the whole catalogue from any directory, not only about the declarations repository.

What does not change: a change is still decided in Git. `idpa "<change>"` previews a diff
against the declarations repository, a person reviews it, and the merge is the act of
authorisation. The catalogue lags the repository by its processing loop, and this tool never
writes to Backstage — no registration call, no refresh, no deletion.
