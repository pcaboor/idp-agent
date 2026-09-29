import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse, parseAllDocuments } from 'yaml'
import { renderRegistration } from '../../src/core/validate/registration.js'
import { comparable, overserved } from '../../scripts/backstage-recording.mjs'

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

    describe('records a page only when the catalogue served something new, and never one that was overserved', () => {
      const script = readFileSync(path.join(ROOT, 'scripts/demo-backstage-docker.mjs'), 'utf8')
      type Recorded = { items: { metadata: Record<string, unknown>; spec?: Record<string, unknown> }[] }
      const recorded = (name: string): Recorded =>
        JSON.parse(readFileSync(path.join(ROOT, 'tests/contract/backstage', name), 'utf8')) as Recorded
      const fixtures = readdirSync(path.join(ROOT, 'tests/contract/backstage'))
      const modelled = fixtures.find((name) => name.startsWith('by-query-'))
      const organisation = fixtures.find((name) => name.startsWith('org-by-query-'))

      /** The page served again: the same entities, in the reverse order, with the uids and etags a new run draws. */
      const servedAgain = (before: Recorded): Recorded => ({
        ...before,
        items: before.items
          .map((item, index) => ({ ...item, metadata: { ...item.metadata, uid: `uid-${index}`, etag: `etag-${index}` } }))
          .reverse(),
      })

      it.each([modelled, organisation])('holds %s, served again with new uids, etags and order, as the same recording', (name) => {
        const before = recorded(String(name))
        const again = servedAgain(before)
        expect(again.items[0]).not.toEqual(before.items[0])
        expect(comparable(again)).toBe(comparable(before))
      })

      it('holds a page with one changed field, or one annotation more, as a new recording', () => {
        const before = recorded(String(modelled))
        const [first, ...rest] = servedAgain(before).items
        const changed = { ...first, spec: { ...first?.spec, lifecycle: 'deprecated' } }
        expect(comparable({ ...before, items: [first, ...rest] })).toBe(comparable(before))
        expect(comparable({ ...before, items: [changed, ...rest] })).not.toBe(comparable(before))
        const annotated = { ...first, metadata: { ...first?.metadata, annotations: { note: 'new' } } }
        expect(comparable({ ...before, items: [annotated, ...rest] })).not.toBe(comparable(before))
      })

      it('finds, in an organisation page, the items that carry a profile or annotations it did not ask for', () => {
        const page = recorded(String(organisation))
        expect(overserved(page)).toEqual([])
        const [ada, ...rest] = page.items
        const profiled = { ...ada, spec: { ...ada?.spec, profile: { email: 'ada@acme.example' } } }
        const annotated = { ...ada, metadata: { ...ada?.metadata, annotations: { 'acme.example/email': 'ada@acme.example' } } }
        expect(overserved({ ...page, items: [profiled, ...rest] })).toEqual([profiled])
        expect(overserved({ ...page, items: [annotated, ...rest] })).toEqual([annotated])
      })

      it('writes a fixture only through the comparison, and the organisation one only after the refusal', () => {
        expect(script).toContain("import { comparable, overserved } from './backstage-recording.mjs'")
        expect(script).toContain('if (before !== undefined && comparable(before) === comparable(served)) {')
        expect(script).toContain('writeRecording(FIXTURE, JSON.parse(page.body),')
        // writeRecording is the one place a fixture is written.
        expect(script.match(/writeFileSync\(/g)).toHaveLength(1)
        const refused = script.indexOf('const refused = overserved(served)')
        expect(refused).toBeGreaterThan(0)
        expect(script.indexOf('if (refused.length > 0) {')).toBeGreaterThan(refused)
        expect(script.indexOf('writeRecording(ORGANISATION_FIXTURE, served,')).toBeGreaterThan(script.indexOf('if (refused.length > 0) {'))
      })
    })

    it('is started, demonstrated and stopped by package scripts, never by the suite', () => {
      const { scripts } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
      expect(scripts['demo:backstage:docker']).toBe('node scripts/demo-backstage-docker.mjs')
      expect(scripts['backstage:up']).toBe('node scripts/backstage-compose.mjs up -d --build --wait')
      expect(scripts['backstage:down']).toBe('node scripts/backstage-compose.mjs down')
      expect(scripts['backstage:clean']).toBe('node scripts/backstage-compose.mjs down --rmi all')
      expect(scripts['test']).toBe('vitest run')
    })

    describe('runs compose quietly: one line a call, and all of it when a call fails', () => {
      const helper = readFileSync(path.join(ROOT, 'scripts/backstage-compose.mjs'), 'utf8')
      const script = readFileSync(path.join(ROOT, 'scripts/demo-backstage-docker.mjs'), 'utf8')

      it('asks compose for plain progress, which never redraws, and holds its output', () => {
        expect(helper).toContain("['compose', '-f', COMPOSE_FILE, '--progress', 'plain', ...args]")
        // stdout and stderr share one file descriptor: held, and in the order compose wrote them.
        expect(helper).toContain("stdio: ['ignore', fd, fd]")
      })

      it('makes every compose call of the Docker demo through it', () => {
        expect(script).toContain("import { compose, shown } from './backstage-compose.mjs'")
        // The one direct call left is the check that Compose v2 is installed, whose output is ignored.
        expect(script.match(/'compose'/g)).toEqual(["'compose'"])
        expect(script).toContain("spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' })")
      })

      // A fake `docker` on PATH: it prints a redrawn progress bar, as compose
      // does when piped, on stdout and stderr in turn, and exits as told.
      // Docker itself is never started.
      const fakeDocker = (
        status: number,
        call = "compose(['up', '-d', '--build', '--wait'])",
        quiet = false,
      ): { run: SpawnSyncReturns<string>; argv: string[] } => {
        const bin = mkdtempSync(path.join(tmpdir(), 'fake-docker-'))
        try {
          const log = path.join(bin, 'argv.json')
          writeFileSync(
            path.join(bin, 'docker'),
            [
              '#!/usr/bin/env node',
              `require('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))`,
              "if (process.env.FAKE_QUIET !== '1') for (let i = 0; i < 40; i++) (i % 2 ? process.stdout : process.stderr).write(`[+] Running ${i}/40\\n`)",
              "if (process.env.FAKE_STATUS !== '0') process.stderr.write('#9 ERROR: process \"yarn install\" did not complete successfully: exit code: 1\\n')",
              'process.exit(Number(process.env.FAKE_STATUS))',
            ].join('\n'),
          )
          chmodSync(path.join(bin, 'docker'), 0o755)
          const helper = pathToFileURL(path.join(ROOT, 'scripts/backstage-compose.mjs')).href
          const run = spawnSync(
            process.execPath,
            ['--input-type=module', '-e', `import { compose, shown } from ${JSON.stringify(helper)}; process.exitCode = ${call}`],
            {
              encoding: 'utf8',
              env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, FAKE_STATUS: String(status), FAKE_QUIET: quiet ? '1' : '0' },
            },
          )
          return { run, argv: JSON.parse(readFileSync(log, 'utf8')) as string[] }
        } finally {
          rmSync(bin, { recursive: true, force: true })
        }
      }
      const running = Array.from({ length: 40 }, (_, i) => `[+] Running ${i}/40\n`).join('')

      it.skipIf(process.platform === 'win32')('prints one line when compose succeeds', () => {
        const { run, argv } = fakeDocker(0)
        expect(argv).toEqual(['compose', '-f', path.join(DEMO, 'compose.yml'), '--progress', 'plain', 'up', '-d', '--build', '--wait'])
        expect(run.status).toBe(0)
        expect(run.stdout).toBe('docker compose up -d --build --wait: done\n')
        expect(run.stderr).toBe('')
      })

      it.skipIf(process.platform === 'win32')("shows compose's whole output, in the order compose printed it, and its status when it fails", () => {
        const { run } = fakeDocker(17)
        expect(run.status).toBe(17)
        expect(run.stdout).toBe('')
        expect(run.stderr).toBe(
          `${running}#9 ERROR: process "yarn install" did not complete successfully: exit code: 1\n` +
            'docker compose up -d --build --wait exited 17\n',
        )
      })

      it.skipIf(process.platform === 'win32')('passes through what a call is run for, such as Backstage\'s own log', () => {
        const { run, argv } = fakeDocker(0, "shown(['logs', '--no-color', '--tail=200', 'backstage'])")
        expect(argv).toEqual(['compose', '-f', path.join(DEMO, 'compose.yml'), '--progress', 'plain', 'logs', '--no-color', '--tail=200', 'backstage'])
        expect(run.status).toBe(0)
        expect(run.stdout).toBe('')
        expect(run.stderr).toBe(running)
      })

      it.skipIf(process.platform === 'win32')('says so when that call printed nothing, as `logs` does with no container', () => {
        const { run } = fakeDocker(0, "shown(['logs', '--no-color', '--tail=200', 'backstage'])", true)
        expect(run.status).toBe(0)
        expect(run.stderr).toBe('docker compose logs --no-color --tail=200 backstage printed nothing\n')
      })

      it('shows Backstage\'s own log before `down` removes it, when it did not start or its catalogue did not fill', () => {
        const log = "shown(['logs', '--no-color', '--tail=200', 'backstage'], COMPOSE_ENV)"
        expect(script).toContain(log)
        const start = script.indexOf("compose(['up', '-d', '--build', '--wait'], COMPOSE_ENV)")
        const notStarted = script.indexOf('if (started !== 0) {', start)
        expect(start).toBeGreaterThan(0)
        expect(notStarted).toBeGreaterThan(start)
        expect(script.slice(notStarted, script.indexOf('}', notStarted))).toContain('showBackstageLog()')
        const timeout = script.indexOf('if (Date.now() > until) {')
        expect(timeout).toBeGreaterThan(notStarted)
        expect(script.slice(timeout, script.indexOf('}', timeout))).toContain('showBackstageLog()')
        // The helper already said how compose exited: the demo says what it did not do.
        expect(script).not.toMatch(/fail\(`docker compose .* exited/)
      })
    })

    it('registers the organisation as data of its own, allowed Group and User and nothing else', () => {
      const [, org] = at(config, 'catalog', 'locations') as Mapping[]
      expect(org).toEqual({ type: 'file', target: '/app/org/org.yaml', rules: [{ allow: ['Group', 'User'] }] })
      const documents = parseAllDocuments(read('org.yaml')).map((document) => document.toJS() as Mapping)
      expect(documents.map((document) => [document['kind'], at(document, 'metadata', 'name')])).toEqual([
        ['Group', 'engineering'],
        ['Group', 'common'],
        ['Group', 'dodowarriors'],
        ['Group', 'elephant'],
        ['Group', 'tiger'],
        ['User', 'ada'],
        ['User', 'linus'],
      ])
      // Every team is engineering's child, and every User's group exists: over
      // the fake and the Docker Backstage, nothing is declared nowhere.
      expect(at(documents[0] as Mapping, 'spec', 'children')).toEqual(['common', 'dodowarriors', 'elephant', 'tiger'])
      const script = readFileSync(path.join(ROOT, 'scripts/demo-backstage-docker.mjs'), 'utf8')
      expect(script).toContain('const expected = { Group: 5, User: 2, Location: 3 }')
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
