import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse, parseAllDocuments } from 'yaml'
import { renderRegistration } from '../../src/core/validate/registration.js'

/**
 * The demo Backstage in Docker (tools/backstage/README.md), read as files:
 * Docker is never needed by the suite, so what can be checked without running
 * it is checked here — the registration is slice 0's bytes, the configuration
 * is docs/adopting-backstage.md's, the ports are this machine's alone, and
 * every version is pinned. `pnpm demo:backstage:docker` is the proof that it
 * runs.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const DEMO = path.join(ROOT, 'tools/backstage')
const read = (file: string): string => readFileSync(path.join(DEMO, file), 'utf8')

type Mapping = Record<string, unknown>
const at = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((into, key) => (into as Mapping | undefined)?.[key], value)

const config = parse(read('app-config.yaml')) as Mapping
const compose = parse(read('compose.yml')) as Mapping
const dockerfile = read('Dockerfile')
const page = readFileSync(path.join(ROOT, 'docs/adopting-backstage.md'), 'utf8')

/** Every ```yaml block of the adopting page, parsed. */
const pageBlocks = [...page.matchAll(/```yaml\n([\s\S]*?)```/g)].map(([, block]) => parse(block ?? '') as Mapping)

describe('the demo Backstage', () => {
  describe('the registration', () => {
    it('is the Location init platform writes for a directory named si-demo, byte for byte', () => {
      // Regenerate with: pnpm build && node -e 'import("./dist/core/validate/registration.js").then((m) => process.stdout.write(m.renderRegistration("si-demo")))' > tools/backstage/registration/catalog-info.yaml
      expect(read('registration/catalog-info.yaml')).toBe(renderRegistration('si-demo'))
    })

    it('sits beside a copy of the demo SI in the image, where the one catalog.locations entry names it', () => {
      expect(dockerfile).toMatch(/^COPY --from=si-demo \. \.\/si-demo\/$/m)
      expect(dockerfile).toMatch(/^COPY registration\/catalog-info\.yaml \.\/si-demo\/catalog-info\.yaml$/m)
      expect(dockerfile).toMatch(/^WORKDIR \/app$/m)
      expect(at(compose, 'services', 'backstage', 'build', 'additional_contexts')).toEqual({ 'si-demo': '../../fixtures/si-demo' })
      const locations = at(config, 'catalog', 'locations') as Mapping[]
      expect(locations[0]).toMatchObject({ type: 'file', target: '/app/si-demo/catalog-info.yaml' })
    })
  })

  describe('the configuration is docs/adopting-backstage.md', () => {
    it("allows the repository's kinds from its location, as the page writes the rules", () => {
      const registered = pageBlocks.flatMap((block) => (at(block, 'catalog', 'locations') as Mapping[] | undefined) ?? [])
      expect(registered.length).toBeGreaterThan(0)
      const [demo] = at(config, 'catalog', 'locations') as Mapping[]
      for (const entry of registered) expect(demo?.['rules']).toEqual(entry['rules'])
      expect(demo?.['rules']).toEqual([{ allow: ['Location', 'Component', 'API', 'Resource'] }])
      // No global rules: Backstage's defaults apply everywhere else, as the page assumes.
      expect(at(config, 'catalog', 'rules')).toBeUndefined()
    })

    it('issues the static read token the page recommends, restricted to catalog.entity.read', () => {
      const recommended = pageBlocks.find((block) => at(block, 'backend', 'auth', 'externalAccess') !== undefined)
      expect(at(config, 'backend', 'auth', 'externalAccess')).toEqual(at(recommended, 'backend', 'auth', 'externalAccess'))
      expect(at(config, 'backend', 'auth', 'externalAccess')).toEqual([
        {
          type: 'static',
          options: { token: '${IDPA_CATALOG_TOKEN}', subject: 'idp-agent' },
          accessRestrictions: [{ plugin: 'catalog', permission: 'catalog.entity.read' }],
        },
      ])
    })
  })

  describe("what the demo adds, each part stated as the demo's", () => {
    it("reads the token's value from the environment, with a demo default the script shows", () => {
      const token = at(compose, 'services', 'backstage', 'environment', 'IDPA_CATALOG_TOKEN')
      expect(token).toBe('${IDPA_CATALOG_TOKEN:-idpa-demo-read-only-token}')
      const script = readFileSync(path.join(ROOT, 'scripts/demo-backstage-docker.mjs'), 'utf8')
      expect(script).toContain("const DEMO_TOKEN = 'idpa-demo-read-only-token'")
    })

    it('publishes its one port on 127.0.0.1 only, and serves the frontend there too', () => {
      const services = at(compose, 'services') as Mapping
      const ports = Object.values(services).flatMap((service) => ((service as Mapping)['ports'] as string[] | undefined) ?? [])
      expect(ports).toEqual(['127.0.0.1:7007:7007'])
      expect(at(config, 'backend', 'baseUrl')).toBe('http://127.0.0.1:7007')
      expect(at(config, 'app', 'baseUrl')).toBe('http://127.0.0.1:7007')
      expect(compose['name']).toBe('idp-agent-demo-backstage')
    })

    it('keeps its database in memory, and offers guest sign-in', () => {
      expect(at(config, 'backend', 'database')).toEqual({ client: 'better-sqlite3', connection: ':memory:' })
      expect(at(config, 'auth', 'providers')).toEqual({ guest: { dangerouslyAllowOutsideDevelopment: true } })
    })

    it('runs as node, with no capability, no privilege to gain and its files read-only to it', () => {
      const service = at(compose, 'services', 'backstage') as Mapping
      expect(service['security_opt']).toEqual(['no-new-privileges:true'])
      expect(service['cap_drop']).toEqual(['ALL'])
      expect(service['cap_add']).toBeUndefined()
      const run = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '))
      expect(run).toMatch(/^USER node$/m)
      // Owned by root, readable by node: the backend writes nothing under /app.
      expect(run).not.toContain('--chown')
    })

    it('rewrites the contract fixture only after a run that went as documented', () => {
      const script = readFileSync(path.join(ROOT, 'scripts/demo-backstage-docker.mjs'), 'utf8')
      const refused = script.indexOf('if (failed) {')
      const recorded = script.indexOf('if (record) {')
      expect(refused).toBeGreaterThan(0)
      expect(recorded).toBeGreaterThan(refused)
    })

    it('is started, demonstrated and stopped by package scripts, never by the suite', () => {
      const { scripts } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
      expect(scripts['demo:backstage:docker']).toBe('node scripts/demo-backstage-docker.mjs')
      expect(scripts['backstage:up']).toBe('docker compose -f tools/backstage/compose.yml up -d --build --wait')
      expect(scripts['backstage:down']).toBe('docker compose -f tools/backstage/compose.yml down')
      expect(scripts['backstage:clean']).toBe('docker compose -f tools/backstage/compose.yml down --rmi all')
      expect(scripts['test']).toBe('vitest run')
    })

    it('registers the teams as organisation data of their own, allowed Group and nothing else', () => {
      const [, org] = at(config, 'catalog', 'locations') as Mapping[]
      expect(org).toEqual({ type: 'file', target: '/app/org/org.yaml', rules: [{ allow: ['Group'] }] })
      const groups = parseAllDocuments(read('org.yaml')).map((document) => document.toJS() as Mapping)
      expect(groups.map((group) => [group['kind'], at(group, 'metadata', 'name')])).toEqual([
        ['Group', 'common'],
        ['Group', 'dodowarriors'],
        ['Group', 'elephant'],
        ['Group', 'tiger'],
      ])
    })
  })

  describe('every version is pinned', () => {
    const app = JSON.parse(read('app/package.json')) as Mapping
    const release = (JSON.parse(read('app/backstage.json')) as { version: string }).version

    it('names one Backstage release, in backstage.json, the image tag and the Dockerfile', () => {
      expect(release).toMatch(/^\d+\.\d+\.\d+$/)
      expect(at(compose, 'services', 'backstage', 'image')).toBe(`idp-agent-demo-backstage:${release}`)
      expect(dockerfile).toContain(`Backstage ${release}`)
    })

    it('depends on exact @backstage versions, with a committed lockfile and its package manager', () => {
      const manifests = ['app/package.json', 'app/packages/app/package.json', 'app/packages/backend/package.json'].map(
        (file) => JSON.parse(read(file)) as Mapping,
      )
      const backstage = manifests.flatMap((manifest) =>
        ['dependencies', 'devDependencies'].flatMap((field) =>
          Object.entries((manifest[field] as Record<string, string> | undefined) ?? {}).filter(([name]) => name.startsWith('@backstage/')),
        ),
      )
      expect(backstage.length).toBeGreaterThan(0)
      for (const [name, version] of backstage) expect([name, version]).toEqual([name, expect.stringMatching(/^\d+\.\d+\.\d+$/)])
      // The version and its hash: corepack refuses a Yarn binary that is not the one named.
      expect(app['packageManager']).toMatch(/^yarn@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/)
      expect(read('app/yarn.lock')).toContain('"@backstage/plugin-catalog-backend@npm:')
      expect(dockerfile).toContain('yarn install --immutable')
    })

    it('builds on a Node image pinned by version and digest, in both stages', () => {
      expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:\d+\.\d+\.\d+-[a-z]+-slim@sha256:[0-9a-f]{64}$/m)
      expect(dockerfile.match(/^FROM .*/gm)).toEqual(['FROM ${NODE_IMAGE} AS build', 'FROM ${NODE_IMAGE}'])
    })
  })
})
