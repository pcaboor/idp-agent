import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import {
  branchAnswer,
  commitAnswer,
  openPullsAnswer,
  pullAnswer,
  pullFilesAnswer,
  pullsAnswer,
  refAnswer,
  repositoryAnswer,
  rulesAnswer,
  rulesetAnswer,
  userAnswer,
  type RefAnswer,
} from '../../../src/core/github/answers.js'
import { GH_MINIMUM_VERSION, isAtLeast, parseGhVersion } from '../../../src/core/github/gh-version.js'
import { MERGE_NOTE } from '../../../src/core/github/protection.js'
import { isBranch } from '../../../src/core/github/remote.js'
import { GH_LIMITS, checkGhArgv, ghArgv, ghEnvironment, ghIn, parseIncluded, spawnGh, type GhClient, type GhRoute } from '../../../src/process/gh.js'
import {
  ANSWERS_DIRECTORY,
  TOKEN_SHAPE,
  identifying,
  scrubbed,
  shapeOf,
  type AnswersFile,
  type DoorEntry,
  type DoorObserved,
  type RouteEntry,
  type StepOutcome,
} from '../../support/github-answers.js'
import {
  cleanupTargets,
  liveBaseOf,
  liveGitEnvironment,
  liveRepository,
  neverMerged,
  remembered,
  reviewerConfigDir,
  reviewerEnvironment,
  stampedBranches,
  mentionRenderedAsCode,
  type EndLook,
} from '../guard.js'
import {
  LIVE_DOORS,
  QUEUED_PAUSES_MS,
  doorLine,
  doorOutcome,
  doorRefusals,
  queuedOutcome,
  type LiveContext,
  type LiveDoor,
  type Observation,
} from './doors.js'

/**
 * The owner's live test of stage 6 (stage 6 brief § 10, live half; stage 6
 * plan, Task 6.4.1), run by hand with `pnpm test:live:github`, never in CI,
 * against the public throwaway repository `IDP_GITHUB_LIVE_REPO` names — the
 * demo SI on its default branch, § 8's ruleset there, its bypass list empty —
 * with the owner's own gh and git, and, when
 * `IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR` names one, a second account's gh.
 *
 * It passes only when `idpa protection` passes there, a submission opens a
 * pull request, a second submission names it and writes nothing, the same
 * change proposed by someone else is named (with the second account), a
 * different change to the same file is refused (what is in flight is read
 * first, 2026-10-01), every door is refused to the identity that opened the
 * pull request with the base's commit read and unchanged after each, an
 * approval followed by the opener's push leaves the opener's merge refused
 * (with the second account), and a base no ruleset protects still gets its
 * pull request, with the note (the pull request is always opened,
 * 2026-10-01). The second account is optional: the steps that need another
 * person skip without it, saying so.
 *
 * Every read goes through the real launcher, `ghIn` with `spawnGh`, so the
 * grammar and `parseIncluded` meet GitHub, and is parsed with
 * `core/github/answers.ts`'s schema for its route, so an answer the schemas
 * refuse fails where it was read. The test's own calls — the clone, the doors,
 * the review, the cleanup — are `execFile` with no shell. What the run
 * answers is written, logins removed, to `tests/contract/github/`, whatever
 * its outcome; the contract test holds the fake gh to it. It never prints a gh
 * body or a git stderr but through `scrubbed`.
 *
 * Never a merge that could succeed: nothing merges between the approval and
 * the push — the guards refuse a repository that allows auto-merge or a base
 * a merge queue rules, and step 5 a pull request with auto-merge on — no door
 * is sent that `doorRefusals` answers anything for, and the base's commit is
 * read after each door. A door counts as refused only for a reason
 * `doorOutcome` classifies as the rules' — and `merge-async`, which GitHub
 * answers 202 and judges later (2026-10-02), only once six reads over 30 s
 * found the pull request never merged and the base where it was
 * (`queuedOutcome`). Before the cleanup closes anything and again after it,
 * every pull request the run opened is read `merged: false` and the base at
 * the commit the run found it at (`neverMerged`, written in the file): the
 * run fails otherwise, so a queued merge that completed later in the run is
 * never missed. The test's own git runs without any
 * `GIT_*` but the four ways of reaching GitHub, and pushes only to an origin
 * that is the live repository. `afterAll` closes every pull request the run
 * opened and deletes every branch it pushed — those its CLI runs named, and
 * every `idp-agent/` branch holding the run's stamp — whatever happened, and
 * never the base.
 */

const ROOT = path.resolve(import.meta.dirname, '../../..')
const BIN = path.join(ROOT, 'dist/cli/bin.js')
const EXAMPLE = path.join(ROOT, 'examples/open-network.json')

const { owner, name } = liveRepository(process.env)
const reviewerDir = reviewerConfigDir(process.env)
const REPOSITORY = `${owner}/${name}`
const PRINTED = `github.com/${REPOSITORY}`

/** The run's UTC time, `yyyymmddhhmmss`: every name the run makes on GitHub carries it. */
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const LIVE_BASE = liveBaseOf(stamp)
const ENTITY = `orders-api-to-payments-${stamp}`

/** The owner's environment, as the setup file scrubbed it. */
const ownerEnv: NodeJS.ProcessEnv = { ...process.env }

/** The test's own git's: no `GIT_*` but the four ways of reaching GitHub. */
const gitEnv: NodeJS.ProcessEnv = liveGitEnvironment(ownerEnv)

/** The URL the test clones, and the only one its git pushes to. */
const ORIGIN = `git@github.com:${REPOSITORY}.git`

/**
 * The second account's: its gh configuration directory, and none of the
 * variables that outrank `GH_CONFIG_DIR` in gh and would answer as the owner.
 */
const reviewerEnv: NodeJS.ProcessEnv | undefined = reviewerDir === undefined ? undefined : reviewerEnvironment(process.env, reviewerDir)

const SKIPPED_REVIEWER =
  'IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR is not set: no second account, so this step is skipped'

// ---------------------------------------------------------------- processes

interface Ran {
  readonly code: number | string | null
  readonly stdout: string
  readonly stderr: string
}

/** A process with no shell, its exit, stdout and stderr; never throws for an exit. */
const run = (
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly cwd: string; readonly timeoutMs?: number; readonly input?: string },
): Promise<Ran> =>
  new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      { env: options.env, cwd: options.cwd, timeout: options.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' || typeof error.code === 'string' ? error.code : null
        resolve({ code, stdout, stderr })
      },
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input)
  })

/** gh as the test runs it itself: gh's environment, as the launcher builds it, from a neutral directory. */
const gh = (args: readonly string[], env: NodeJS.ProcessEnv = ownerEnv): Promise<Ran> =>
  run('gh', args, { env: ghEnvironment(env), cwd: scratch(), timeoutMs: 60_000 })

/** The test's own git, in the clone. */
const git = async (...args: string[]): Promise<string> => {
  const ran = await run('git', ['-C', clone(), ...args], { env: gitEnv, cwd: scratch() })
  if (ran.code !== 0) throw new Error(`git ${args[0] ?? ''} failed in the test's clone: ${said(ran)}`)
  return ran.stdout.trim()
}

/** Before any push of the test's own: the clone's origin fetches from and pushes to the live repository, and nowhere else. */
const originIsLive = async (): Promise<void> => {
  const fetchUrl = await git('remote', 'get-url', '--all', 'origin')
  const pushUrl = await git('remote', 'get-url', '--push', '--all', 'origin')
  if (fetchUrl !== ORIGIN || pushUrl !== ORIGIN) {
    throw new Error(`the test's clone's origin is not ${ORIGIN} alone, for fetch and for push: nothing is pushed`)
  }
}

/** The built CLI, with no terminal, so `--submit` is the answer. */
const idpa = (args: readonly string[], env: NodeJS.ProcessEnv = ownerEnv): Promise<Ran> =>
  run(process.execPath, [BIN, ...args], { env, cwd: scratch(), timeoutMs: 170_000 })

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

// ---------------------------------------------------------------- what the run keeps

let temporary: string | undefined
const scratch = (): string => {
  if (temporary === undefined) throw new Error('the run has no temporary directory')
  return temporary
}
const clone = (): string => path.join(scratch(), 'clone')

const steps: { -readonly [K in keyof AnswersFile['steps']]: AnswersFile['steps'][K] } = {
  protection: 'not-run',
  baseRoutes: 'not-run',
  submitted: 'not-run',
  again: 'not-run',
  proposedAgain: 'not-run',
  competing: 'not-run',
  doors: 'not-run',
  afterApproval: 'not-run',
  noted: 'not-run',
  cleanup: 'not-run',
}
let stopped = false

const routes = new Map<string, RouteEntry>()
const doors: DoorEntry[] = []
const measured: {
  gh: AnswersFile['gh']
  git: AnswersFile['git']
  readBack: AnswersFile['readBack']
  include: AnswersFile['include']
  bypass: AnswersFile['bypass']
  mention: AnswersFile['mention']
  tokenShapeInBody: AnswersFile['tokenShapeInBody']
  note: AnswersFile['note']
  neverMerged: AnswersFile['neverMerged']
} = { gh: null, git: null, readBack: null, include: null, bypass: null, mention: null, tokenShapeInBody: null, note: null, neverMerged: null }

/** Who the accounts are, as GitHub answered: for the file's scrub and its last check, never written. */
const people: { ownerLogin?: string; reviewerLogin?: string; secrets: { text: string; kind: string }[] } = { secrets: [] }

/** What the run made on GitHub, for `afterAll` to undo whatever happened. */
const made = { pulls: new Set<number>(), branches: new Set<string>(), liveBase: false }

/** Every pull request the run opened, as far as its end knows: kept from the look before the cleanup to the one after it. */
const everOpened = new Set<number>()

/** The looks at what the run opened, at its end: before the cleanup, and after it (`neverMerged`). */
const looks: EndLook[] = []

/** What the steps learn and hand on. */
const known: {
  base?: string
  baseSha?: string
  number?: number
  branch?: string | undefined
  head?: string
  nodeId?: string | undefined
  liveBaseRules?: readonly { type: string }[]
} = {}

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`an earlier step did not say ${what}`)
  return value
}

/** The names the file's text is scrubbed of: the logins, and the repository's owner. */
const scrubNames = (): { text: string; as: '<owner>' | '<reviewer>' }[] => [
  ...(people.ownerLogin === undefined ? [] : [{ text: people.ownerLogin, as: '<owner>' as const }]),
  ...(people.reviewerLogin === undefined ? [] : [{ text: people.reviewerLogin, as: '<reviewer>' as const }]),
  { text: owner, as: '<owner>' },
]

/** A process's output, scrubbed, for an assertion's message: what the CLI says is the engine's, gh's and git's are cleaned the same way. */
const said = (ran: Ran): string =>
  scrubbed(`exit ${String(ran.code)}\n--- stdout\n${ran.stdout}\n--- stderr\n${ran.stderr}`, scrubNames())

// ---------------------------------------------------------------- reads, through the launcher

const clients: { owner?: GhClient; reviewer?: GhClient } = {}
const client = (account: 'owner' | 'reviewer'): GhClient => {
  if (account === 'owner') return (clients.owner ??= ghIn({ env: ownerEnv }))
  if (reviewerEnv === undefined) throw new Error('no second account')
  return (clients.reviewer ??= ghIn({ env: reviewerEnv }))
}

/**
 * One read through the launcher, recorded raw — its status, whether a next
 * page is named, its body's shape — then parsed with the route's schema when
 * GitHub answered 2xx, so an answer the schemas refuse fails here.
 */
async function read<T>(
  account: 'owner' | 'reviewer',
  route: GhRoute,
  schema: { parse(value: unknown): T },
  subject?: RouteEntry['subject'],
): Promise<{ status: number; hasNext: boolean; raw: unknown; parsed: T | undefined }> {
  const answer = await client(account).get(route)
  let raw: unknown
  try {
    raw = JSON.parse(answer.body)
  } catch {
    throw new Error(`GitHub's answer to ${route.route} (${String(answer.status)}) is not JSON`)
  }
  routes.set(`${account} ${route.route} ${subject ?? ''}`, {
    account,
    route: route.route,
    ...(subject === undefined ? {} : { subject }),
    status: answer.status,
    hasNext: answer.hasNext,
    shape: shapeOf(raw),
  })
  const parsed = answer.status >= 200 && answer.status < 300 ? schema.parse(raw) : undefined
  return { status: answer.status, hasNext: answer.hasNext, raw, parsed }
}

/** A read that must answer 2xx. */
async function readOk<T>(
  account: 'owner' | 'reviewer',
  route: GhRoute,
  schema: { parse(value: unknown): T },
  subject?: RouteEntry['subject'],
): Promise<{ raw: unknown; parsed: T; hasNext: boolean }> {
  const answer = await read(account, route, schema, subject)
  if (answer.parsed === undefined) throw new Error(`GitHub answered ${String(answer.status)} to ${route.route}`)
  return { raw: answer.raw, parsed: answer.parsed, hasNext: answer.hasNext }
}

/** The pull request read by the test itself, `full+json`: its node id, its body and its HTML. */
async function pullOf(number: number): Promise<Record<string, unknown>> {
  const ran = await gh([
    'api',
    '--hostname',
    'github.com',
    '--method',
    'GET',
    '--include',
    '-H',
    'Accept: application/vnd.github.full+json',
    `repos/${REPOSITORY}/pulls/${String(number)}`,
  ])
  const answer = parseIncluded(Buffer.from(ran.stdout, 'utf8'))
  if (answer === undefined || answer.status !== 200) throw new Error(`the pull request #${String(number)} did not read: ${said(ran)}`)
  const raw = JSON.parse(answer.body) as Record<string, unknown>
  pullAnswer.parse(raw)
  return raw
}

const refOf = (branch: string): GhRoute => ({ route: 'ref', owner, name, branch })

/** The base's commit on GitHub, read through the launcher. */
const baseNow = async (): Promise<string> =>
  (await readOk('owner', refOf(need(known.base, 'the base')), refAnswer, 'base')).parsed.object.sha

/** Pull request #n, from its branch: open and not merged. */
const stillOpen = async (): Promise<boolean> => {
  const { parsed } = await readOk('owner', { route: 'pulls', owner, name, head: need(known.branch, 'the branch') }, pullsAnswer, 'submission')
  return parsed.length === 1 && parsed[0]?.number === known.number && parsed[0]?.state === 'open' && parsed[0]?.merged_at === null
}

/** The open pull requests into the base, by number. */
const openInto = async (base: string): Promise<number[]> => {
  const { parsed } = await readOk('owner', { route: 'open-pulls', owner, name, base, page: 1 }, openPullsAnswer, 'base')
  return parsed.map((pull) => pull.number).sort((a, b) => a - b)
}

// ---------------------------------------------------------------- the CLI's lines

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** Every pull request and branch a CLI run says it made, kept for `afterAll` whatever the step expected. */
const remember = (ran: Ran): void => {
  const told = remembered(ran.stdout)
  for (const number of told.pulls) made.pulls.add(number)
  for (const branch of told.branches) made.branches.add(branch)
}

const submittingLine = (base: string, login: string): string =>
  `submitting to ${PRINTED}, into ${base} (origin, ${base}'s upstream), as ${login} (gh)`

/** `examples/open-network.json`, its entity named `entity`, its consumer `consumer`, the request ending `cc @<login>`. */
async function planFile(file: string, entity: string, consumer: string): Promise<string> {
  const example = (await readFile(EXAMPLE, 'utf8'))
    .replaceAll('orders-api-to-payments', entity)
    .replaceAll('component:default/orders-api', consumer)
  const plan = JSON.parse(example) as { intent: string }
  plan.intent = `${plan.intent} cc @${people.reviewerLogin ?? need(people.ownerLogin, "the owner's login")}`
  const where = path.join(scratch(), file)
  await writeFile(where, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  return where
}

// ---------------------------------------------------------------- the steps

type StepKey = Exclude<keyof AnswersFile['steps'], 'protection' | 'cleanup'>

/** The steps, in the order written: each runs once, after every step before it. */
const ORDER: readonly StepKey[] = ['baseRoutes', 'submitted', 'again', 'proposedAgain', 'competing', 'doors', 'afterApproval', 'noted']

/**
 * One step: skipped when an earlier one failed, its outcome kept for the file,
 * and the steps stopped when it fails. A step that runs a second time — a
 * retry — or before a step written above it — a shuffle — fails before
 * sending anything, whatever the command line asked of vitest: the approval
 * must come after every door, and no door or approval is sent twice.
 */
const step = (key: StepKey, title: string, body: (context: TestContext) => Promise<void>): void => {
  it(title, async (context) => {
    if (stopped) context.skip('an earlier step failed: nothing more is tried')
    try {
      if (steps[key] !== 'not-run') throw new Error(`step ${key} ran already: a step runs once, and is never retried`)
      const early = ORDER.slice(0, ORDER.indexOf(key)).filter((before) => steps[before] === 'not-run')
      if (early.length > 0) throw new Error(`step ${key} came before ${early.join(', ')}: the steps run in the order written`)
      await body(context)
      if (steps[key] === 'not-run') (steps as Record<StepKey, string>)[key] = key === 'afterApproval' ? 'made' : 'passed'
      process.stderr.write(`live: ${key} ${steps[key]}\n`)
    } catch (error) {
      if (steps[key] === 'skipped') {
        process.stderr.write(`live: ${key} skipped\n`)
        throw error
      }
      steps[key] = 'failed'
      stopped = true
      process.stderr.write(`live: ${key} failed\n`)
      throw error
    }
  })
}

/** Skips a step that needs the second account, saying so. */
const withoutReviewer = (key: StepKey, context: TestContext, claim: string): void => {
  if (reviewerEnv !== undefined) return
  steps[key] = 'skipped'
  process.stderr.write(`live: ${SKIPPED_REVIEWER}; ${claim}\n`)
  context.skip(SKIPPED_REVIEWER)
}

// ---------------------------------------------------------------- the guards

/** g2 to g9: reads only, and the test's own clone. Each throws naming its check. */
async function guards(): Promise<void> {
  // g2
  if (!existsSync(BIN)) throw new Error('g2: dist/cli/bin.js does not exist: run pnpm build first')

  temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'idpa-live-')))

  // g3
  const version = await client('owner').version()
  const parsedVersion = parseGhVersion(version)
  if (parsedVersion === undefined) throw new Error('g3: gh --version printed no version this build reads')
  measured.gh = { version: parsedVersion, date: /\((\d{4}-\d{2}-\d{2})\)/.exec(version)?.[1] ?? 'unknown' }
  if (!isAtLeast(parsedVersion, GH_MINIMUM_VERSION)) {
    throw new Error(`g3: gh ${parsedVersion} is older than ${GH_MINIMUM_VERSION}, the oldest this build reads`)
  }
  const gitVersion = await run('git', ['--version'], { env: gitEnv, cwd: scratch() })
  measured.git = { version: /git version (\S+)/.exec(gitVersion.stdout)?.[1] ?? 'unknown' }

  // g4
  const me = await readOk('owner', { route: 'user' }, userAnswer)
  people.ownerLogin = me.parsed.login
  const meRaw = me.raw as { name?: unknown; email?: unknown }
  people.secrets.push({ text: me.parsed.login, kind: 'the owner’s login' })
  if (typeof meRaw.name === 'string') people.secrets.push({ text: meRaw.name, kind: 'the owner’s name' })
  if (typeof meRaw.email === 'string') people.secrets.push({ text: meRaw.email, kind: 'the owner’s email' })
  if (me.parsed.type !== 'User') throw new Error(`g4: gh is logged in as a ${me.parsed.type}, not a person`)

  // g5
  const held = await readOk('owner', { route: 'repository', owner, name }, repositoryAnswer)
  const heldRaw = held.raw as { private?: unknown; default_branch?: unknown; allow_auto_merge?: unknown }
  if (held.parsed.full_name.toLowerCase() !== REPOSITORY.toLowerCase()) throw new Error('g5: the repository answers under another name')
  if (heldRaw.private !== false) throw new Error('g5: the repository is not public')
  if (held.parsed.archived) throw new Error('g5: the repository is archived')
  if (!held.parsed.permissions.push) throw new Error('g5: the owner’s gh may not push to the repository')
  if (heldRaw.allow_auto_merge === true) {
    throw new Error(
      'g5: the repository allows auto-merge, which could merge the pull request once the second account approves it: ' +
        'turn "Allow auto-merge" off in its Settings → General, or take it to the owner of the plan.',
    )
  }
  if (typeof heldRaw.default_branch !== 'string' || !isBranch(heldRaw.default_branch)) {
    throw new Error('g5: the repository names no default branch this build reads')
  }
  known.base = heldRaw.default_branch
  const role = held.parsed.permissions.admin
    ? 'admin'
    : held.parsed.permissions.maintain === true
      ? 'maintain'
      : 'write'

  // g6
  if (reviewerEnv !== undefined) {
    const them = await readOk('reviewer', { route: 'user' }, userAnswer)
    people.reviewerLogin = them.parsed.login
    const themRaw = them.raw as { name?: unknown; email?: unknown }
    people.secrets.push({ text: them.parsed.login, kind: 'the reviewer’s login' })
    if (typeof themRaw.name === 'string') people.secrets.push({ text: themRaw.name, kind: 'the reviewer’s name' })
    if (typeof themRaw.email === 'string') people.secrets.push({ text: themRaw.email, kind: 'the reviewer’s email' })
    if (them.parsed.type !== 'User') throw new Error(`g6: the second account's gh is logged in as a ${them.parsed.type}, not a person`)
    if (them.parsed.login.toLowerCase() === me.parsed.login.toLowerCase()) {
      throw new Error('g6: the second account’s gh answers as the owner: unset GH_TOKEN and GITHUB_TOKEN for it, or log it in as another person')
    }
    const theirs = await readOk('reviewer', { route: 'repository', owner, name }, repositoryAnswer)
    if (!theirs.parsed.permissions.push) throw new Error('g6: the second account may not push to the repository')
  } else {
    process.stderr.write('live: IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR is not set: the steps that need another person will be skipped\n')
  }

  // g7
  const cloned = await run('git', ['clone', '--quiet', '--branch', known.base, ORIGIN, clone()], {
    env: gitEnv,
    cwd: scratch(),
    timeoutMs: 120_000,
  })
  if (cloned.code !== 0) throw new Error(`g7: the test's clone failed: ${said(cloned)}`)
  await originIsLive().catch((error: unknown) => {
    throw new Error(`g7: ${(error as Error).message}`)
  })

  // g8
  const protection = await idpa(['protection', '--repo', clone()])
  if (protection.code !== 0) throw new Error(`g8: idpa protection does not pass: ${said(protection)}`)

  // g9
  const rules = await readOk('owner', { route: 'rules', owner, name, branch: known.base }, rulesAnswer, 'base')
  const binding = [
    ...new Set(rules.parsed.filter((rule) => ['pull_request', 'non_fast_forward', 'deletion'].includes(rule.type)).map((rule) => rule.ruleset_id)),
  ]
  if (!rules.parsed.some((rule) => rule.type === 'pull_request')) throw new Error('g9: no ruleset requires a pull request on the base')
  if (rules.parsed.some((rule) => rule.type === 'merge_queue')) {
    throw new Error(
      'g9: a merge queue rules the base, and a door could enqueue the pull request, to be merged once it is approved. ' +
        'Stop here and take it to the owner of the plan.',
    )
  }
  const bypassing: string[] = []
  const actors = new Map<string, number>()
  let readable = true
  for (const id of binding) {
    const ruleset = await readOk('owner', { route: 'ruleset', owner, name, id }, rulesetAnswer)
    const can = ruleset.parsed.current_user_can_bypass ?? 'absent'
    if (can !== 'never') bypassing.push(can)
    if (ruleset.parsed.bypass_actors === undefined) readable = false
    for (const actor of ruleset.parsed.bypass_actors ?? []) actors.set(actor.actor_type, (actors.get(actor.actor_type) ?? 0) + 1)
    if (reviewerEnv !== undefined) await readOk('reviewer', { route: 'ruleset', owner, name, id }, rulesetAnswer)
  }
  measured.bypass = {
    currentUserCanBypass: bypassing[0] ?? 'never',
    role,
    bypassActors: readable ? [...actors.entries()].map(([type, count]) => ({ type, count })) : 'unreadable',
  }
  if (bypassing.length > 0) {
    throw new Error(
      `g9: a ruleset on the base answers current_user_can_bypass ${bypassing.join(', ')} to the owner: the design says an ` +
        'administrator outside the bypass list is bound. Stop here and take it to the owner of the plan.',
    )
  }

  // What --include prints for an answer that is not 2xx, and gh's exit then:
  // a branch GitHub does not hold, read through the launcher's pieces.
  const absent: GhRoute = { route: 'ref', owner, name, branch: `live/${stamp}/absent` }
  const argv = ghArgv({ kind: 'get', route: absent })
  checkGhArgv(argv)
  const exit = await spawnGh(argv, { env: ownerEnv, limits: GH_LIMITS })
  const included = parseIncluded(exit.stdout)
  measured.include = {
    status: included?.status ?? 0,
    nonSuccessParsed: included !== undefined,
    exitOnNonSuccess: exit.code ?? null,
  }
  if (included === undefined) {
    throw new Error('a non-2xx answer parseIncluded cannot read: process/gh.ts classifies it wrongly. Take it to the owner of the plan.')
  }

  known.baseSha = await baseNow()
  if ((await git('rev-parse', 'HEAD')) !== known.baseSha) throw new Error("g7: the test's clone is not level with the base")
}

// ---------------------------------------------------------------- the run

beforeAll(async () => {
  try {
    await guards()
    steps.protection = 'passed'
    process.stderr.write('live: protection passed\n')
  } catch (error) {
    steps.protection = 'failed'
    stopped = true
    process.stderr.write('live: protection failed\n')
    throw error
  }
})

afterAll(async () => {
  // Before the cleanup closes anything: a queued merge that completed after its door was judged is seen here.
  if (temporary !== undefined && known.baseSha !== undefined) looks.push(await endLook())
  await cleanup()
  measured.neverMerged = known.baseSha === undefined ? null : neverMerged(looks, known.baseSha)
  if (known.baseSha !== undefined) process.stderr.write(`${endLine(measured.neverMerged)}\n`)
  await record()
  if (known.baseSha !== undefined && measured.neverMerged !== true) {
    const base = need(known.base, 'the base')
    throw new Error(
      measured.neverMerged === false
        ? `a pull request the run opened was merged, or ${base} moved from the commit the run found it at, by the end of the run — ` +
            'a queued merge may have completed after its door was judged: the invariant does not hold as built. ' +
            `See to ${PRINTED} by hand, and take it to the owner of the plan.`
        : `whether a pull request the run opened was merged could not be read at the end of the run: it proves nothing until it is. See to ${PRINTED} by hand.`,
    )
  }
})

// The steps run in the order written, one after the other: nothing here is
// concurrent, and each step reads what the one before it left.
describe(`stage 6, live, on ${PRINTED}`, () => {
  step('baseRoutes', '1. a base whose name holds a slash answers every route, read back within three reads', async () => {
    const baseSha = need(known.baseSha, "the base's commit")
    await originIsLive()
    await git('push', '--quiet', 'origin', `${baseSha}:refs/heads/${LIVE_BASE}`)
    made.liveBase = true
    let reads = 0
    let answer: RefAnswer | undefined
    for (const pause of [0, 500, 1500]) {
      await wait(pause)
      reads += 1
      answer = (await read('owner', refOf(LIVE_BASE), refAnswer, 'live-base')).parsed
      if (answer !== undefined) break
    }
    measured.readBack = { reads, lagSeen: reads > 1 }
    if (answer === undefined) {
      throw new Error('the base needed more than three reads to read back: § 4’s bound is too tight. Take it to the owner of the plan.')
    }
    expect(answer.ref).toBe(`refs/heads/${LIVE_BASE}`)
    expect(answer.object.sha).toBe(baseSha)
    const branch = await readOk('owner', { route: 'branch', owner, name, branch: LIVE_BASE }, branchAnswer, 'live-base')
    expect((branch.raw as { name?: unknown }).name).toBe(LIVE_BASE)
    const rules = await readOk('owner', { route: 'rules', owner, name, branch: LIVE_BASE }, rulesAnswer, 'live-base')
    expect(rules.hasNext).toBe(false)
    known.liveBaseRules = rules.parsed
    await readOk('owner', { route: 'branch', owner, name, branch: need(known.base, 'the base') }, branchAnswer, 'base')
  })

  step('submitted', '2. a submission opens a pull request, its mention written as code', async () => {
    const base = need(known.base, 'the base')
    const baseSha = need(known.baseSha, "the base's commit")
    const file = await planFile('submit.json', ENTITY, 'component:default/orders-api')
    const ran = await idpa(['plan', '--from', file, '--repo', clone(), '--submit'])
    remember(ran)
    expect(ran.code, said(ran)).toBe(0)
    expect(ran.stderr, said(ran)).toContain(submittingLine(base, need(people.ownerLogin, "the owner's login")))
    const opened = new RegExp(
      `^Pull request #([1-9][0-9]*) opened on ${escaped(PRINTED)}: https://${escaped(PRINTED)}/pull/([1-9][0-9]*)$`,
      'm',
    ).exec(ran.stdout)
    expect(opened, said(ran)).not.toBeNull()
    const number = Number(opened?.[1])
    expect(Number(opened?.[2])).toBe(number)
    const branch = /submitted as (idp-agent\/[a-z0-9-]+-[0-9a-f]{8}) on top of /.exec(ran.stdout)?.[1]
    expect(branch, said(ran)).toBeDefined()
    known.number = number
    known.branch = branch

    const pulls = await readOk('owner', { route: 'pulls', owner, name, head: need(branch, 'the branch') }, pullsAnswer, 'submission')
    expect(pulls.parsed.map((pull) => [pull.number, pull.state])).toEqual([[number, 'open']])
    const local = await git('rev-parse', `refs/heads/${need(branch, 'the branch')}`)
    const ref = await readOk('owner', refOf(need(branch, 'the branch')), refAnswer, 'submission')
    expect(ref.parsed.object.sha).toBe(local)
    known.head = local
    const commit = await readOk('owner', { route: 'commit', owner, name, sha: local }, commitAnswer, 'submission')
    expect(commit.parsed.parents.map((parent) => parent.sha)).toEqual([baseSha])

    const pull = await pullOf(number)
    routes.set('owner pull submission', { account: 'owner', route: 'pull', subject: 'submission', status: 200, hasNext: false, shape: shapeOf(pull) })
    known.nodeId = typeof pull['node_id'] === 'string' ? pull['node_id'] : undefined
    const html = typeof pull['body_html'] === 'string' ? pull['body_html'] : ''
    const mention = `@${(people.reviewerLogin ?? need(people.ownerLogin, "the owner's login")).toLowerCase()}`
    measured.mention = { renderedAsCode: mentionRenderedAsCode(html, mention) }
    measured.tokenShapeInBody = TOKEN_SHAPE.test(typeof pull['body'] === 'string' ? pull['body'] : '')
    expect(measured.mention.renderedAsCode).toBe(true)
    expect(measured.tokenShapeInBody).toBe(false)

    // What is in flight into the base, and the pull request's files: the two reads of 6.3.6.
    expect(await openInto(base)).toContain(number)
    const files = await readOk('owner', { route: 'pull-files', owner, name, number }, pullFilesAnswer, 'submission')
    expect(files.parsed.map((one) => [one.filename, one.status])).toEqual([[`dependencies/network/${ENTITY}.yml`, 'added']])
  })

  step('again', '3. the same submission again names the pull request and writes nothing', async () => {
    const branch = need(known.branch, 'the branch')
    const number = need(known.number, 'the pull request')
    const before = await git('for-each-ref')
    const ran = await idpa(['plan', '--from', path.join(scratch(), 'submit.json'), '--repo', clone(), '--submit'])
    remember(ran)
    expect(ran.code, said(ran)).toBe(0)
    expect(ran.stdout, said(ran)).toContain(`already submitted as ${branch} · pull request #${String(number)} is open · nothing written`)
    expect(await git('for-each-ref')).toBe(before)
    expect(await stillOpen()).toBe(true)
    expect((await readOk('owner', refOf(branch), refAnswer, 'submission')).parsed.object.sha).toBe(need(known.head, 'the head'))
  })

  step('proposedAgain', '3b. the same change, proposed by someone else, is named and nothing is written', async (context) => {
    withoutReviewer('proposedAgain', context, 'an identical proposal by another person rests on the fake alone')
    const base = need(known.base, 'the base')
    const number = need(known.number, 'the pull request')
    const before = { refs: await git('for-each-ref'), open: await openInto(base) }
    const ran = await idpa(['plan', '--from', path.join(scratch(), 'submit.json'), '--repo', clone(), '--submit'], reviewerEnv)
    remember(ran)
    expect(ran.code, said(ran)).toBe(0)
    expect(ran.stderr, said(ran)).toContain(submittingLine(base, need(people.reviewerLogin, "the reviewer's login")))
    expect(ran.stderr, said(ran)).toContain(`already proposed by ${need(people.ownerLogin, "the owner's login")} in pull request #${String(number)}`)
    expect(ran.stdout, said(ran)).toContain(
      `already proposed in pull request #${String(number)} on ${PRINTED}: https://${PRINTED}/pull/${String(number)} · nothing written`,
    )
    expect(await git('for-each-ref')).toBe(before.refs)
    expect(await openInto(base)).toEqual(before.open)
  })

  step('competing', '3c. a different change to the same file is refused, the other pull request shown, nothing written', async () => {
    const base = need(known.base, 'the base')
    const number = need(known.number, 'the pull request')
    const file = await planFile('competing.json', ENTITY, 'component:default/billing-api')
    const before = { refs: await git('for-each-ref'), open: await openInto(base) }
    const ran = await idpa(['plan', '--from', file, '--repo', clone(), '--submit'])
    remember(ran)
    expect(ran.code, said(ran)).toBe(1)
    expect(ran.stdout, said(ran)).toContain('1 file · not submitted:')
    expect(ran.stdout, said(ran)).toContain(
      `pull request #${String(number)} on ${PRINTED} already changes dependencies/network/${ENTITY}.yml, differently: ` +
        `https://${PRINTED}/pull/${String(number)}`,
    )
    expect(ran.stderr, said(ran)).toContain(
      `pull request #${String(number)} is by ${need(people.ownerLogin, "the owner's login")}, from ${need(known.branch, 'the branch')}`,
    )
    expect(await git('for-each-ref')).toBe(before.refs)
    expect(await openInto(base)).toEqual(before.open)
  })

  step('doors', '4. every door is refused to the identity that opened the pull request, the base unchanged after each', async () => {
    for (const door of LIVE_DOORS.filter((one) => one.step === 'doors')) await tryDoor(door)
  })

  step('afterApproval', "5. after another person's approval and the author's push, the author's merge is refused", async (context) => {
    withoutReviewer(
      'afterApproval',
      context,
      "the claim about a push after an approval rests on the fake and the rule's read alone (require_last_push_approval)",
    )
    const number = need(known.number, 'the pull request')
    const branch = need(known.branch, 'the branch')
    const head = need(known.head, 'the head')
    const reviewer = need(people.reviewerLogin, "the reviewer's login")
    // Nothing may merge it once approved: auto-merge off on the pull request, as the guards found it off on the repository.
    const before = await pullOf(number)
    if (before['auto_merge'] !== null) {
      throw new Error(
        `pull request #${String(number)} does not answer auto_merge null: an approval could merge it. ` +
          'Nothing was approved. Stop here and take it to the owner of the plan.',
      )
    }
    const approved = await gh(['pr', 'review', String(number), '--repo', REPOSITORY, '--approve'], reviewerEnv)
    expect(approved.code, said(approved)).toBe(0)
    const reviews = await gh(['api', '--hostname', 'github.com', '--method', 'GET', '--include', `repos/${REPOSITORY}/pulls/${String(number)}/reviews`])
    const listed = parseIncluded(Buffer.from(reviews.stdout, 'utf8'))
    expect(listed?.status, said(reviews)).toBe(200)
    const approvals = (JSON.parse(listed?.body ?? '[]') as { user?: { login?: string } | null; state?: string }[]).filter(
      (review) => review.state === 'APPROVED' && review.user?.login?.toLowerCase() === reviewer.toLowerCase(),
    )
    expect(approvals.length).toBeGreaterThan(0)

    // One file on top of the approved head, pushed by the author, never forced.
    const index = path.join(scratch(), 'index')
    const env = { ...gitEnv, GIT_INDEX_FILE: index }
    const inClone = async (args: string[], input?: string): Promise<string> => {
      const ran = await run('git', ['-C', clone(), ...args], { env, cwd: scratch(), ...(input === undefined ? {} : { input }) })
      if (ran.code !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${said(ran)}`)
      return ran.stdout.trim()
    }
    await inClone(['read-tree', head])
    const blob = await inClone(['hash-object', '-w', '--stdin'], `pushed by the author after an approval, ${stamp}\n`)
    await inClone(['update-index', '--add', '--cacheinfo', `100644,${blob},live/${stamp}.txt`])
    const tree = await inClone(['write-tree'])
    const top = await inClone(['commit-tree', tree, '-p', head, '-m', 'idpa live test: pushed on top of the approved head'])
    await originIsLive()
    await git('push', '--quiet', 'origin', `${top}:refs/heads/${branch}`)
    let seen: string | undefined
    for (const pause of [0, 500, 1500]) {
      await wait(pause)
      const { raw } = await readOk('owner', { route: 'pulls', owner, name, head: branch }, pullsAnswer, 'submission')
      seen = (raw as { head?: { sha?: string } }[])[0]?.head?.sha
      if (seen === top) break
    }
    expect(seen).toBe(top)
    known.head = top

    // Nothing merged between the approval and the push. Now the author's merge.
    for (const door of LIVE_DOORS.filter((one) => one.step === 'after-approval')) await tryDoor(door)
  })

  step('noted', '6. on a base no ruleset protects, the pull request is opened all the same, with the note', async (context) => {
    const rules = need(known.liveBaseRules, "the live base's rules")
    if (rules.some((rule) => rule.type === 'pull_request')) {
      steps.noted = 'skipped'
      process.stderr.write(`live: a ruleset requires a pull request on ${LIVE_BASE} too, so no base here lacks one; the note rests on the fake\n`)
      context.skip('a ruleset covers the live base too')
    }
    const entity = `${ENTITY}-noted`
    const file = await planFile('noted.json', entity, 'component:default/orders-api')
    await git('checkout', '--quiet', '-b', LIVE_BASE)
    await git('config', `branch.${LIVE_BASE}.remote`, 'origin')
    await git('config', `branch.${LIVE_BASE}.merge`, `refs/heads/${LIVE_BASE}`)
    const ran = await idpa(['plan', '--from', file, '--repo', clone(), '--submit'])
    remember(ran)
    await git('checkout', '--quiet', need(known.base, 'the base'))
    expect(ran.code, said(ran)).toBe(0)
    expect(ran.stderr, said(ran)).toContain(submittingLine(LIVE_BASE, need(people.ownerLogin, "the owner's login")))
    const opened = new RegExp(`^Pull request #([1-9][0-9]*) opened on ${escaped(PRINTED)}: .*\\n(.*)$`, 'm').exec(ran.stdout)
    expect(opened, said(ran)).not.toBeNull()
    expect(opened?.[2]).toBe('No status check is required, so a system downstream could not refuse it (ADR-0012).')
    const pull = await pullOf(Number(opened?.[1]))
    const body = typeof pull['body'] === 'string' ? pull['body'] : ''
    measured.note = { onStderr: ran.stderr.split('\n').includes(MERGE_NOTE), inBody: body.split(/\r?\n/).includes(MERGE_NOTE) }
    expect(measured.note).toEqual({ onStderr: true, inBody: true })
  })
})

// ---------------------------------------------------------------- the doors

/**
 * One door, as the owner: never sent when `doorRefusals` answers anything for
 * it, then GitHub's answer classified (`doorOutcome`) — a queued one observed
 * first, and judged on what the observations saw (`queuedOutcome`) — and
 * recorded, then the base read and the pull request still open.
 */
async function tryDoor(door: LiveDoor): Promise<void> {
  const context: LiveContext = {
    owner,
    name,
    base: need(known.base, 'the base'),
    number: need(known.number, 'the pull request'),
    branch: need(known.branch, 'the branch'),
    head: need(known.head, 'the head'),
    baseSha: need(known.baseSha, "the base's commit"),
    nodeId: need(known.nodeId, "the pull request's node id"),
    stamp,
    clone: clone(),
  }
  const argv = door.argv(context)
  const unsafe = doorRefusals(door.via, argv, context)
  if (unsafe.length > 0) throw new Error(`${door.name} was never sent: ${unsafe.join('; ')}`)
  let ran: Ran
  if (door.via === 'git-push') {
    await originIsLive()
    ran = await run('git', argv, { env: gitEnv, cwd: scratch(), timeoutMs: 120_000 })
  } else {
    ran = await gh(argv)
  }
  const answered = doorOutcome(door, ran)
  let outcome = answered
  let observed: DoorObserved | undefined
  let bases: readonly string[] = []
  if (answered.reason === 'queued') {
    // GitHub took the merge to judge it later: what the pull request and the base say after it is its answer.
    const observations = await observe(context.number)
    outcome = queuedOutcome(answered, observations, context.baseSha)
    observed = {
      reads: observations.length,
      seconds: QUEUED_PAUSES_MS.reduce((sum, pause) => sum + pause, 0) / 1000,
      merged: observations.some((seen) => seen.merged),
    }
    bases = observations.map((seen) => seen.baseSha)
  }
  const entry: Omit<DoorEntry, 'baseUnchanged'> = {
    door: door.name,
    via: door.via,
    step: door.step,
    reachedGitHub: outcome.reachedGitHub,
    exit: ran.code,
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
    ...(outcome.errors === undefined ? {} : { errors: outcome.errors }),
    refused: outcome.refused,
    reason: outcome.reason,
    remote: outcome.remote.map((line) => scrubbed(line, scrubNames())),
    ...(observed === undefined ? {} : { observed }),
  }
  const baseUnchanged = (await baseNow()) === context.baseSha && bases.every((sha) => sha === context.baseSha)
  const open = await stillOpen()
  const recorded: DoorEntry = { ...entry, baseUnchanged }
  doors.push(recorded)
  process.stderr.write(`${doorLine(recorded)}\n`)
  const carried = entry.reason === 'accepted' || entry.reason === 'queued'
  if (!entry.refused && !carried && baseUnchanged && open) {
    throw new Error(
      `${door.name} was not tried: ${entry.reason === 'not-sent' ? 'it failed before reaching GitHub' : `GitHub answered ${entry.reason}`}, ` +
        `which proves nothing of the rules. ${said(ran)}`,
    )
  }
  if (!entry.refused || !baseUnchanged || !open) {
    throw new Error(
      `${door.name} was not refused to the identity that opened the pull request (the base ${baseUnchanged ? 'unchanged' : 'moved'}, ` +
        `the pull request ${open ? 'open' : 'no longer open'}${observed?.merged === true ? ', merged after GitHub accepted it' : ''}): ` +
        'the invariant does not hold as built. Stop here and take it to the owner of the plan.',
    )
  }
}

/**
 * After a queued door: the pull request read on its own route — its `merged`,
 * not only whether it is open — and the base's commit, once after each of
 * `QUEUED_PAUSES_MS`. A pull request answering no `merged` stops the run:
 * whether the merge happened would not be known.
 */
async function observe(number: number): Promise<Observation[]> {
  const observations: Observation[] = []
  for (const pause of QUEUED_PAUSES_MS) {
    await wait(pause)
    const pull = await pullOf(number)
    const merged = pull['merged']
    if (typeof merged !== 'boolean') {
      throw new Error(`pull request #${String(number)} answered no merged field: whether the queued merge happened is not known`)
    }
    observations.push({ merged, open: pull['state'] === 'open', baseSha: await baseNow() })
  }
  return observations
}

// ---------------------------------------------------------------- after the run

/**
 * Every pull request the run opened closed, every branch it pushed deleted,
 * the temporary directory removed, each named on stderr. The branches are
 * those the CLI's lines named, and every `idp-agent/` branch on the
 * repository holding the run's stamp — a branch pushed whose pull request was
 * not opened, or by a run killed at its bound — each open pull request from
 * one closed too; `cleanupTargets` refuses anything else, the base first.
 */
async function cleanup(): Promise<void> {
  const failures: string[] = []
  if (temporary !== undefined) {
    const listed = await run('git', ['ls-remote', '--heads', ORIGIN, 'refs/heads/idp-agent/*'], { env: gitEnv, cwd: scratch(), timeoutMs: 60_000 })
    const stamped = listed.code === 0 ? stampedBranches(listed.stdout, stamp) : []
    if (listed.code !== 0) failures.push(`the idp-agent/ branches holding ${stamp}, which could not be listed`)
    for (const branch of stamped) {
      made.branches.add(branch)
      const answer = await client('owner')
        .get({ route: 'pulls', owner, name, head: branch })
        .catch(() => undefined)
      const pulls = answer?.status === 200 ? pullsAnswer.safeParse(JSON.parse(answer.body)) : undefined
      if (pulls?.success !== true) failures.push(`the pull requests from ${branch}, which could not be read`)
      for (const pull of pulls?.success === true ? pulls.data : []) if (pull.state === 'open') made.pulls.add(pull.number)
    }
    for (const number of made.pulls) {
      const closed = await gh(['pr', 'close', String(number), '--repo', REPOSITORY])
      if (closed.code === 0) process.stderr.write(`live: cleanup: pull request #${String(number)} closed\n`)
      else if (!/already closed/i.test(closed.stderr)) failures.push(`pull request #${String(number)} (gh pr close)`)
    }
    const { targets, refused } = cleanupTargets({
      branches: [...made.branches, ...(made.liveBase ? [LIVE_BASE] : [])],
      base: known.base,
      stamp,
    })
    for (const branch of refused) failures.push(`the branch ${branch}, which the cleanup may not delete`)
    for (const branch of targets) {
      const route = `repos/${REPOSITORY}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`
      const deleted = await gh(['api', '--hostname', 'github.com', '--method', 'DELETE', '--include', route])
      const status = parseIncluded(Buffer.from(deleted.stdout, 'utf8'))?.status
      if (status === 204) process.stderr.write(`live: cleanup: ${branch} deleted\n`)
      else if (status !== 422 && status !== 404) failures.push(`the branch ${branch}`)
    }
    if (known.base !== undefined && known.baseSha !== undefined && (await baseNow().catch(() => undefined)) !== known.baseSha) {
      failures.push(`the base ${known.base}, which is no longer where the run found it`)
      stopped = true
    }
    // After it, and before the directory every gh and git of the test's runs in goes.
    if (known.baseSha !== undefined) looks.push(await endLook())
    await rm(temporary, { recursive: true, force: true })
  }
  steps.cleanup = failures.length === 0 ? (temporary === undefined ? 'not-run' : 'passed') : 'failed'
  if (failures.length > 0) {
    process.stderr.write(`live: the cleanup failed for ${failures.join(', ')}: see to them by hand on ${PRINTED}\n`)
  }
}

/**
 * One look at what the run opened, at its end: each pull request's `merged`,
 * read on its own route, and the base's commit, `undefined` where a read
 * failed. The pull requests are those the CLI's lines named and every one from
 * an `idp-agent/` branch holding the run's stamp, whatever its state — a
 * merged one is closed, and the cleanup closes only open ones. Reads only, and
 * never throws: the cleanup runs after it whatever it finds.
 */
async function endLook(): Promise<EndLook> {
  try {
    const merged: (boolean | undefined)[] = []
    for (const number of made.pulls) everOpened.add(number)
    const listed = await run('git', ['ls-remote', '--heads', ORIGIN, 'refs/heads/idp-agent/*'], { env: gitEnv, cwd: scratch(), timeoutMs: 60_000 })
    if (listed.code !== 0) merged.push(undefined)
    for (const branch of listed.code === 0 ? stampedBranches(listed.stdout, stamp) : []) {
      const answer = await client('owner')
        .get({ route: 'pulls', owner, name, head: branch })
        .catch(() => undefined)
      let numbers: number[] | undefined
      try {
        numbers = answer?.status === 200 ? pullsAnswer.parse(JSON.parse(answer.body)).map((pull) => pull.number) : undefined
      } catch {
        numbers = undefined
      }
      if (numbers === undefined) merged.push(undefined)
      for (const number of numbers ?? []) everOpened.add(number)
    }
    for (const number of [...everOpened].sort((a, b) => a - b)) {
      const value = (await pullOf(number).catch(() => undefined))?.['merged']
      merged.push(typeof value === 'boolean' ? value : undefined)
    }
    return { merged, baseSha: await baseNow().catch(() => undefined) }
  } catch {
    return { merged: [undefined], baseSha: undefined }
  }
}

/** What the end of the run says on stderr of what it opened. */
function endLine(verdict: boolean | null): string {
  const base = known.base ?? 'the base'
  const numbers = [...everOpened].sort((a, b) => a - b).map((number) => `#${String(number)}`)
  const opened =
    numbers.length === 0 ? 'no pull request opened' : `pull request${numbers.length === 1 ? '' : 's'} ${numbers.join(', ')} unmerged`
  if (verdict === true) return `live: nothing merged: ${opened}, ${base} where the run found it, before the cleanup and after it`
  if (verdict === false) return `live: MERGED: a pull request the run opened was merged, or ${base} moved, by the end of the run`
  return 'live: whether anything the run opened was merged could not be read at its end'
}

/** The answers file, written whatever happened, refused when it still holds what identifies someone. */
async function record(): Promise<void> {
  const optional = (outcome: StepOutcome): boolean => outcome === 'passed' || outcome === 'skipped'
  const passed =
    steps.protection === 'passed' &&
    steps.baseRoutes === 'passed' &&
    steps.submitted === 'passed' &&
    steps.again === 'passed' &&
    optional(steps.proposedAgain) &&
    steps.competing === 'passed' &&
    steps.doors === 'passed' &&
    (steps.afterApproval === 'made' || steps.afterApproval === 'skipped') &&
    optional(steps.noted) &&
    steps.cleanup === 'passed' &&
    measured.neverMerged === true
  const recordedAt = new Date().toISOString()
  const answers: AnswersFile = {
    version: 1,
    recordedAt,
    passed,
    gh: measured.gh,
    git: measured.git,
    repository: scrubbed(REPOSITORY, scrubNames()),
    steps: { ...steps },
    routes: [...routes.values()],
    doors,
    readBack: measured.readBack,
    include: measured.include,
    bypass: measured.bypass,
    mention: measured.mention,
    tokenShapeInBody: measured.tokenShapeInBody,
    note: measured.note,
    neverMerged: measured.neverMerged,
    handFilled: { actionsCanApprovePullRequests: null, gitPushesAsGhAccount: null, bypassListEmpty: null },
  }
  const text = `${JSON.stringify(answers, null, 2)}\n`
  const found = identifying(text, [...people.secrets, { text: owner, kind: "the repository's owner" }])
  if (found.length > 0) {
    throw new Error(`the answers file was not written: it still holds ${found.join(', ')}`)
  }
  await mkdir(ANSWERS_DIRECTORY, { recursive: true })
  const day = recordedAt.slice(0, 10)
  const first = path.join(ANSWERS_DIRECTORY, `answers-${day}.json`)
  const file = existsSync(first) ? path.join(ANSWERS_DIRECTORY, `answers-${day}-${stamp.slice(8)}.json`) : first
  await writeFile(file, text, 'utf8')
  process.stderr.write(`live: ${passed ? 'passed' : 'did not pass'}; the answers are in ${path.relative(ROOT, file)}\n`)
}
