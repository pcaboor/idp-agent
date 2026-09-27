import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * Least privilege in both workflows this project ships: its own CI, and the
 * `validate.yml` that `init platform` writes into a declarations repository —
 * the repository whose merge is the act of authorisation, where a workflow
 * running `npx --yes` with a write token and the checkout's credentials left
 * on disk is the widest door in the design (review, build-ci-7 and build-ci-8).
 *
 * Read as YAML, not matched as text: a `permissions:` in a comment, or under
 * the wrong key, is no permission at all.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')

interface Step {
  readonly uses?: string
  readonly with?: Record<string, unknown>
}
interface Job {
  readonly 'timeout-minutes'?: number
  readonly steps: readonly Step[]
}
interface Workflow {
  readonly permissions?: unknown
  readonly concurrency?: { group?: string; 'cancel-in-progress'?: unknown }
  readonly jobs: Record<string, Job>
}

const workflow = (file: string): Workflow =>
  parse(readFileSync(path.join(ROOT, file), 'utf8')) as Workflow

const WORKFLOWS = ['.github/workflows/ci.yml', 'templates/iac-repo/github/workflows/validate.yml']

describe.each(WORKFLOWS)('%s', (file) => {
  it('grants the token nothing but reading the repository', () => {
    expect(workflow(file).permissions).toEqual({ contents: 'read' })
  })

  it('leaves no credentials behind the checkout', () => {
    const checkouts = Object.values(workflow(file).jobs).flatMap((job) =>
      job.steps.filter((step) => step.uses?.startsWith('actions/checkout@') === true),
    )
    expect(checkouts.length).toBeGreaterThan(0)
    for (const checkout of checkouts) {
      expect(checkout.with?.['persist-credentials']).toBe(false)
    }
  })

  it('bounds every job in time', () => {
    for (const [name, job] of Object.entries(workflow(file).jobs)) {
      expect(job['timeout-minutes'], name).toBeGreaterThan(0)
    }
  })
})

describe("the project's own CI", () => {
  it('cancels a run the next push to the same pull request makes stale', () => {
    const { concurrency } = workflow('.github/workflows/ci.yml')
    expect(concurrency?.group).toMatch(/github\.event_name == 'pull_request' && github\.ref\b/)
    expect(concurrency?.['cancel-in-progress']).toBe(true)
  })

  it('never cancels, nor queues, a run on main', () => {
    // Grouped by the ref, two quick merges cancelled the first one's run and
    // left a commit on main with no CI verdict. A push is in a group of its
    // own, the run's.
    const { concurrency } = workflow('.github/workflows/ci.yml')
    expect(concurrency?.group).toMatch(/\|\| github\.run_id\b/)
  })
})
