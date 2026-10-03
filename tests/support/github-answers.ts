import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * What the owner's live run records of GitHub's answers, and how the fake gh
 * is held to it (stage 6 plan, Task 6.4.1): shared by the recorder
 * (`tests/live/github/submit.live.test.ts`) and the contract test
 * (`tests/contract/github-answers.test.ts`). It names no door — a door is
 * named in `tests/live/` and `tests/support/fake-gh.ts` only — and imports
 * only `node:` built-ins.
 *
 * A shape is an answer's keys and types, and the value of an enumeration under
 * a few keys a decision reads: never a login, a name, an email, an id, a URL
 * or a token, so the file the run writes can be committed.
 */

/** A leaf is its type, `'<string>' | '<number>' | '<boolean>' | '<null>'`, or, under a `KEPT_KEYS` key, the value itself. */
export type Shape = string | number | boolean | null | readonly Shape[] | { readonly [key: string]: Shape }

/** The keys whose value a shape keeps, when it is a boolean, a number or a short enumeration word. */
export const KEPT_KEYS: readonly string[] = [
  'type',
  'current_user_can_bypass',
  'enforcement',
  'target',
  'source_type',
  'bypass_mode',
  'actor_type',
  'state',
  'merged',
  'draft',
  'mergeable_state',
  'archived',
  'private',
  'visibility',
  'protected',
  'admin',
  'maintain',
  'push',
  'pull',
  'triage',
  'required_approving_review_count',
  'require_last_push_approval',
  'dismiss_stale_reviews_on_push',
  'require_code_owner_review',
  // A pull request's file (Task 6.3.6): added, modified, removed…
  'status',
]

const KEPT: ReadonlySet<string> = new Set(KEPT_KEYS)

/** A word an enumeration is made of: `User`, `never`, `pull_request`, `DeployKey`. */
const ENUMERATION = /^[A-Za-z_]{1,40}$/

const typeOf = (value: unknown): string => {
  if (value === null) return '<null>'
  switch (typeof value) {
    case 'string':
      return '<string>'
    case 'number':
      return '<number>'
    case 'boolean':
      return '<boolean>'
    default:
      return '<unknown>'
  }
}

/** The order a shape's array is written in: its elements' JSON, sorted. */
const key = (shape: Shape): string => JSON.stringify(shape)

const shapeUnder = (value: unknown, kept: boolean): Shape => {
  if (Array.isArray(value)) {
    const distinct = new Map<string, Shape>()
    for (const element of value) {
      const shape = shapeUnder(element, false)
      distinct.set(key(shape), shape)
    }
    return [...distinct.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, shape]) => shape)
  }
  if (typeof value === 'object' && value !== null) {
    const shape: Record<string, Shape> = {}
    for (const [name, child] of Object.entries(value)) shape[name] = shapeUnder(child, KEPT.has(name))
    return shape
  }
  if (kept && (typeof value === 'boolean' || typeof value === 'number')) return value
  if (kept && typeof value === 'string' && ENUMERATION.test(value)) return value
  return typeOf(value)
}

/** A parsed JSON value's shape: every key, each leaf its type or, under a `KEPT_KEYS` key, its value; an array its distinct element shapes, sorted. */
export function shapeOf(value: unknown): Shape {
  return shapeUnder(value, false)
}

const isRecord = (shape: Shape): shape is { readonly [key: string]: Shape } =>
  typeof shape === 'object' && shape !== null && !Array.isArray(shape)

/**
 * Paths where `fake` says something `recorded` does not: a key GitHub did not
 * send, another type, another kept value. Empty when the fake is within
 * GitHub. An element of the fake's array must be within at least one of the
 * recorded array's elements; an empty fake array is within any array.
 */
export function fakeWithin(fake: Shape, recorded: Shape, at = '$'): string[] {
  if (Array.isArray(fake)) {
    if (!Array.isArray(recorded)) return [at]
    const recordedElements = recorded as readonly Shape[]
    return (fake as readonly Shape[]).flatMap((element, index) =>
      recordedElements.some((candidate) => fakeWithin(element, candidate).length === 0) ? [] : [`${at}[${String(index)}]`],
    )
  }
  if (isRecord(fake)) {
    if (!isRecord(recorded)) return [at]
    return Object.entries(fake).flatMap(([name, child]) => {
      const there = recorded[name]
      return there === undefined ? [`${at}.${name}`] : fakeWithin(child, there, `${at}.${name}`)
    })
  }
  // Two leaves: the same type, or the same kept value. Both sides apply one
  // rule under one key, so a kept value beside a placeholder is a value GitHub
  // did not send.
  return fake === recorded ? [] : [at]
}

/** `text` with A to Z folded to a to z and nothing else, so every index stays where it was. */
const folded = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

/**
 * Every occurrence of each name, whatever the case of its ASCII letters,
 * replaced by its placeholder. Literal: no pattern is built from a login.
 */
export function scrubbed(text: string, names: readonly { text: string; as: '<owner>' | '<reviewer>' }[]): string {
  let out = text
  for (const name of names) {
    if (name.text === '') continue
    const needle = folded(name.text)
    let result = ''
    let from = 0
    const haystack = folded(out)
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
      result += out.slice(from, at) + name.as
      from = at + needle.length
    }
    out = result + out.slice(from)
  }
  return out
}

/** A GitHub token's shape: `ghp_`, `gho_`, `ghu_`, `ghs_` and `ghr_` tokens, and fine-grained `github_pat_` ones. */
export const TOKEN_SHAPE = /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/

/**
 * Which of the given identifying texts the file still holds, whatever their
 * case, and whether it holds a token's shape: the kinds only, never the text.
 * An empty text identifies nobody and is not looked for.
 */
export function identifying(file: string, secrets: readonly { text: string; kind: string }[]): string[] {
  const lower = file.toLowerCase()
  const kinds = secrets.filter((secret) => secret.text !== '' && lower.includes(secret.text.toLowerCase())).map((secret) => secret.kind)
  if (TOKEN_SHAPE.test(file)) kinds.push('a token’s shape')
  return [...new Set(kinds)]
}

/** One step's outcome; `afterApproval` is `made` rather than `passed`. */
export type StepOutcome = 'passed' | 'failed' | 'skipped' | 'not-run'

/** A route's answer, as one account read it: what the fake is held to. */
export interface RouteEntry {
  readonly account: 'owner' | 'reviewer'
  /**
   * One of the launcher's routes, or `pull`: the single pull request the test
   * reads itself, a stand-in for the answer to the one POST, which the CLI
   * never shows it.
   */
  readonly route: string
  /** Which branch or pull request it was read for, where the route takes one. */
  readonly subject?: 'base' | 'live-base' | 'submission'
  readonly status: number
  readonly hasNext: boolean
  readonly shape: Shape
}

/**
 * Why GitHub refused a door, as the live run classifies its answer (its words
 * are never written): a ruleset or a branch's protection, a review the rules
 * require, the author's own review, a pull request GitHub says is not
 * mergeable, or a route GitHub does not serve (`merge-async`'s 404 alone).
 * A queued door is not among them: its answer refuses nothing (`DoorReason`).
 */
export type DoorRefusal = 'rule' | 'review' | 'own-review' | 'not-mergeable' | 'not-served'

/**
 * Why a door was not tried, though gh or git ran: it was refused before any
 * request, the session or the key was refused, the token lacks a scope, the
 * thing was not found, or GitHub refused it for a reason no class reads — none
 * of which proves the rules.
 */
export type DoorUntried = 'not-sent' | 'unauthenticated' | 'scope' | 'not-found' | 'unrecognised'

/**
 * A door's outcome, by class: `accepted` is a door GitHub carried out;
 * `queued`, a merge GitHub accepted to carry out later (`merge-async`'s 2xx:
 * 202 on 2026-10-02, never merged over 30 s nor at the run's end), neither
 * carried out nor refused when it answered — refused only once the run
 * observed the pull request never merged and the base never moved
 * (`DoorEntry.observed`).
 */
export type DoorReason = DoorRefusal | DoorUntried | 'accepted' | 'queued'

/** What the run saw after a queued door: how many reads, over how many seconds, and whether one found the pull request merged. */
export interface DoorObserved {
  readonly reads: number
  readonly seconds: number
  readonly merged: boolean
}

/** One door, tried as the identity that opened the pull request, and what GitHub answered. */
export interface DoorEntry {
  readonly door: string
  readonly via: 'gh' | 'gh-api' | 'graphql' | 'git-push'
  readonly step: 'doors' | 'after-approval'
  /** GitHub answered: an HTTP status, a GraphQL `errors` array, a `remote:` line, or gh's own refusal after a request. */
  readonly reachedGitHub: boolean
  readonly exit: number | string | null
  /** The HTTP status `--include` printed, for `gh-api` and `graphql`. */
  readonly status?: number
  /** GraphQL: whether the answer held an `errors` array. */
  readonly errors?: boolean
  /** Refused for one of `DoorRefusal`'s reasons, or `queued` and observed never merged, the base unmoved; and only then. */
  readonly refused: boolean
  /** The class of GitHub's answer: why it was refused, or why it was not tried. */
  readonly reason: DoorReason
  /** The base at the commit the run found it at, read after the door — and, for a queued door, at every observation. */
  readonly baseUnchanged: boolean
  /** A refused push's `remote:` lines, logins scrubbed. */
  readonly remote: readonly string[]
  /** A queued door's observations; absent for every other door. */
  readonly observed?: DoorObserved
}

/**
 * What the owner's live run answers, written whatever its outcome
 * (`tests/contract/github/answers-<date>.json`), never holding a login, a
 * name, an email, a token's shape or a body's text. A measure the run did not
 * reach is `null`. The three hand-filled fields are the owner's, filled after
 * the run: no read settles them.
 */
export interface AnswersFile {
  readonly version: 1
  readonly recordedAt: string
  readonly passed: boolean
  readonly gh: { readonly version: string; readonly date: string } | null
  readonly git: { readonly version: string } | null
  readonly repository: string
  readonly steps: {
    readonly protection: StepOutcome
    readonly baseRoutes: StepOutcome
    readonly submitted: StepOutcome
    readonly again: StepOutcome
    /** The same change, proposed again by the second account: named, nothing written (Task 6.3.6). */
    readonly proposedAgain: StepOutcome
    /** A different change to the same file: refused, nothing written (Task 6.3.6). */
    readonly competing: StepOutcome
    readonly doors: StepOutcome
    readonly afterApproval: 'made' | 'skipped' | 'failed' | 'not-run'
    /** A base no rule protects: the pull request opened all the same, with the note (Task 6.3.4). */
    readonly noted: StepOutcome
    readonly cleanup: StepOutcome
  }
  readonly routes: readonly RouteEntry[]
  readonly doors: readonly DoorEntry[]
  readonly readBack: { readonly reads: number; readonly lagSeen: boolean } | null
  /** A read of a branch GitHub does not hold, through the launcher: whether `--include` printed it, and gh's exit. */
  readonly include: { readonly status: number; readonly nonSuccessParsed: boolean; readonly exitOnNonSuccess: number | string | null } | null
  readonly bypass: {
    readonly currentUserCanBypass: string
    readonly role: string
    readonly bypassActors: readonly { readonly type: string; readonly count: number }[] | 'unreadable'
  } | null
  readonly mention: { readonly renderedAsCode: boolean } | null
  readonly tokenShapeInBody: boolean | null
  readonly note: { readonly onStderr: boolean; readonly inBody: boolean } | null
  /**
   * Whether nothing the run opened was ever merged: every pull request it
   * opened read `merged: false`, and the base at the commit the run found it
   * at, before the cleanup closed anything and again after it — so a queued
   * merge that completed after its door was judged is never missed. `false`
   * when a look saw a merge or the base moved; `null` when a read failed or
   * the run never read the base.
   */
  readonly neverMerged: boolean | null
  readonly handFilled: {
    readonly actionsCanApprovePullRequests: boolean | null
    readonly gitPushesAsGhAccount: boolean | null
    readonly bypassListEmpty: boolean | null
  }
}

/**
 * Where a file's doors and its end say the invariant did not hold, by door
 * or by field; empty when it held. Every door reached GitHub, was refused and
 * left the base where it was — a queued one, besides, observed at least once
 * and never merged — and nothing the run opened was merged at its end
 * (`neverMerged`, true). What the contract test holds every committed file to.
 */
export function unheld(answers: Pick<AnswersFile, 'doors' | 'neverMerged'>): string[] {
  const problems: string[] = []
  for (const entry of answers.doors) {
    const where = `${entry.door} (${entry.step})`
    if (!entry.reachedGitHub) problems.push(`${where}: never reached GitHub`)
    if (!entry.refused) problems.push(`${where}: not refused (${entry.reason})`)
    if (!entry.baseUnchanged) problems.push(`${where}: the base moved`)
    if (entry.reason === 'queued') {
      if (entry.observed === undefined || entry.observed.reads < 1) problems.push(`${where}: queued, and never observed`)
      else if (entry.observed.merged) problems.push(`${where}: queued, and observed merged`)
    }
  }
  if (answers.neverMerged !== true) problems.push(`neverMerged is ${String(answers.neverMerged)}, not true`)
  return problems
}

/** Where the committed answers files live. */
export const ANSWERS_DIRECTORY = path.resolve(import.meta.dirname, '../contract/github')

const ANSWERS_FILE = /^answers-\d{4}-\d{2}-\d{2}(?:-\d{6})?\.json$/

/**
 * The committed answers files, oldest first — sorted by name, which is by
 * date. Throws when there is none, the folder included: a pattern with no
 * match is a read error, never an empty set.
 */
export function answersFiles(directory: string = ANSWERS_DIRECTORY): string[] {
  let names: string[] = []
  try {
    names = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const files = names
    .filter((name) => ANSWERS_FILE.test(name))
    .map((name) => path.join(directory, name))
    .filter((file) => statSync(file).isFile())
    .sort()
  if (files.length === 0) {
    throw new Error(
      `no answers file in ${path.relative(process.cwd(), directory) || directory}: the owner's live run writes one ` +
        '(pnpm test:live:github, docs/plans/stage-6-github.md, Task 6.4.1)',
    )
  }
  return files
}
