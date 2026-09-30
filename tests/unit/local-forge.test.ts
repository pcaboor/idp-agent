import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CATALOG_INFO } from '../../src/core/plan/catalog-info.js'
import { clearService, type Cleared } from '../../src/core/plan/clear.js'
import type { Provenance } from '../../src/core/plan/provenance.js'
import { signPlan } from '../../src/core/plan/sign.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import { ForgeInputError } from '../../src/forge/errors.js'
import { openLocalForge } from '../../src/forge/local/forge.js'
import { blobId, treeOf, writeTree } from '../../src/forge/local/objects.js'
import { GitError, gitIn, type Git } from '../../src/process/git.js'
import {
  ACCESS_PATH,
  DATABASE_PATH,
  clearedFor,
  clone,
  removeClones,
  scratch,
} from '../support/forge-fixture.js'
import { committed, git, observable, show, stored } from '../support/git.js'

// Every test here builds a real repository; the run's temp directory is
// removed at the end anyway, and these go first (a small disk fills).
afterAll(removeClones)

/** The lines `after` holds and `before` does not, and the ones it lost. */
const moved = (before: string, after: string): { added: string[]; removed: string[] } => {
  const was = before.split('\n')
  const is = after.split('\n')
  return {
    added: is.filter((line) => !was.includes(line)),
    removed: was.filter((line) => !is.includes(line)),
  }
}

/** Places each clearance's files in the working tree and commits them on HEAD's branch. */
const land = async (repo: string, change: Cleared, message: string): Promise<void> => {
  for (const edit of change.edits) {
    await mkdir(path.dirname(path.join(repo, edit.path)), { recursive: true })
    await writeFile(path.join(repo, edit.path), edit.after)
  }
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', message)
}

describe('git objects, and never a ref', () => {
  it('computes the id git itself gives a blob', async () => {
    const repo = await clone()
    const bytes = Buffer.from('déclaré\n', 'utf8')
    const file = path.join(path.dirname(repo), 'blob')
    await writeFile(file, bytes)
    expect(blobId(bytes, 'sha1')).toBe(await git(repo, 'hash-object', '--no-filters', file))
  })

  it('keeps an executable file executable, and makes a new one regular', async () => {
    const repo = await clone()
    await writeFile(path.join(repo, 'run.yml'), '# run\n', { mode: 0o755 })
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'exec')
    const run = gitIn(repo)
    const blob = await git(repo, 'hash-object', '-w', '--no-filters', path.join(repo, 'run.yml'))
    const root = await git(repo, 'rev-parse', 'HEAD^{tree}')

    const tree = await writeTree(run, root, new Map([['run.yml', blob], ['new/one.yml', blob]]))
    const commit = await git(repo, 'commit-tree', tree, '-m', 'probe')
    const listing = await treeOf(run, commit)

    expect(listing.get('run.yml')?.mode).toBe('100755')
    expect(listing.get('new/one.yml')?.mode).toBe('100644')
  })

  it('refuses to write under a path that is a file at the base', async () => {
    const repo = await clone()
    const run = gitIn(repo)
    const root = await git(repo, 'rev-parse', 'HEAD^{tree}')
    const blob = (await run(['hash-object', '-w', '--stdin'], Buffer.from('x\n'))).toString().trim()
    await expect(writeTree(run, root, new Map([['catalog-info.yaml/inner.yml', blob]]))).rejects.toThrow(
      /is a file at the base/,
    )
  })

  it('refuses to write a file where the base has a folder', async () => {
    const repo = await clone()
    const run = gitIn(repo)
    const root = await git(repo, 'rev-parse', 'HEAD^{tree}')
    const blob = (await run(['hash-object', '-w', '--stdin'], Buffer.from('x\n'))).toString().trim()
    await expect(writeTree(run, root, new Map([['catalog', blob]]))).rejects.toThrow(/is a folder at the base/)
  })
})

describe('opening a local forge', () => {
  it('refuses a directory that is not a git working tree', async () => {
    const plain = await scratch('idp-plain-')
    await expect(openLocalForge(plain, 'declarations')).rejects.toThrow(ForgeInputError)
  })

  it("refuses a directory inside someone else's repository", async () => {
    // Measured on this very repository: `git -C fixtures/si-demo` answers for
    // idp-agent itself. A branch cut there would be cut in the parent.
    const parent = await scratch('idp-parent-')
    await mkdir(path.join(parent, 'iac'))
    await writeFile(path.join(parent, 'iac', 'x.yml'), '# x\n')
    await committed(parent)
    await expect(openLocalForge(path.join(parent, 'iac'), 'declarations')).rejects.toThrow(/not at its root/)
  })

  it('says git is missing, as an argument error, when there is no git to run', async () => {
    const repo = await clone()
    const missing: Git = async (args) => {
      throw new GitError(args, 'ENOENT', '', false)
    }
    await expect(openLocalForge(repo, 'declarations', missing)).rejects.toThrow(/git is not on PATH/)
  })

  it('refuses a detached HEAD, which no merge request could target', async () => {
    const repo = await clone()
    await git(repo, 'checkout', '-q', '--detach')
    const forge = await openLocalForge(repo, 'declarations')
    await expect(forge.base()).rejects.toThrow(/detached/)
    await expect(forge.base()).rejects.toThrow(ForgeInputError)
  })

  it('refuses an unborn HEAD, which has no commit to cut from', async () => {
    const repo = path.join(await scratch('idp-unborn-'), 'iac')
    await mkdir(repo)
    await git(repo, 'init', '-q', '-b', 'main')
    await git(repo, 'config', 'user.name', 'idp-agent tests')
    await git(repo, 'config', 'user.email', 'tests@idp-agent.invalid')
    const forge = await openLocalForge(repo, 'declarations')
    await expect(forge.base()).rejects.toThrow(/main has no commit yet/)
  })

  it('names the branch HEAD is on, and its commit', async () => {
    const repo = await clone()
    const forge = await openLocalForge(repo, 'declarations')
    expect(await forge.base()).toEqual({ branch: 'main', commit: await git(repo, 'rev-parse', 'HEAD') })
    expect(forge.repository).toBe('declarations')
  })

  it('says there is no committer identity before anything is read', async () => {
    // D13: the scrub removes GIT_AUTHOR_* and GIT_COMMITTER_*, so the identity
    // comes from git's config; its absence used to surface after the paid
    // model run, as a generic exit 1 from `commit-tree`. The absence is set up
    // in configuration, not with GIT_CONFIG_NOSYSTEM (the launcher scrubs every
    // GIT_*): an empty name and email in the repository's own file override the
    // global and system files, and git refuses them (measured: "empty ident
    // name (for <>) not allowed", exit 128). That git never GUESSES one when
    // none is configured is the launcher's test (process-git.test.ts).
    const repo = await clone()
    await git(repo, 'config', 'user.name', '')
    await git(repo, 'config', 'user.email', '')
    await expect(openLocalForge(repo, 'declarations')).rejects.toThrow(/identity/)
  })

  it('says there is no author identity when only the committer is configured', async () => {
    // git configures the two apart (`committer.*`, `author.*`). Measured: with
    // only `committer.*` set, `var GIT_COMMITTER_IDENT` succeeds and
    // `commit-tree` then fails at `submit` — after the paid run (D13).
    const repo = await clone()
    await git(repo, 'config', 'user.name', '')
    await git(repo, 'config', 'user.email', '')
    await git(repo, 'config', 'committer.name', 'A committer')
    await git(repo, 'config', 'committer.email', 'committer@idp-agent.invalid')
    await expect(openLocalForge(repo, 'declarations')).rejects.toThrow(ForgeInputError)
    await expect(openLocalForge(repo, 'declarations')).rejects.toThrow(/author/)
  })
})

describe('what the gates judged, against the base', () => {
  it('finds nothing to say about a repository the gates just read', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    expect(await forge.diverges(await forge.base(), change.expected)).toEqual([])
  })

  it('names a tracked file changed in the working tree and not committed', async () => {
    const repo = await clone()
    const file = path.join(repo, 'catalog-info.yaml')
    await writeFile(file, `${await readFile(file, 'utf8')}# edited, not committed\n`)
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const found = await forge.diverges(await forge.base(), change.expected)
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('catalog-info.yaml differs from main@')
  })

  it('names a catalogue file git ignores, which the gates read and HEAD does not hold', async () => {
    const repo = await clone()
    await writeFile(path.join(repo, '.gitignore'), 'catalog/databases/ignored.yml\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'ignore one')
    await writeFile(path.join(repo, 'catalog', 'databases', 'ignored.yml'), '# ignored\n')
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const found = await forge.diverges(await forge.base(), change.expected)
    expect(found).toEqual([
      expect.stringContaining('catalog/databases/ignored.yml was read but is not in main@'),
    ])
  })

  it('names a catalogue file HEAD holds and the gates never read', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    await writeFile(path.join(repo, 'catalog', 'databases', 'late.yml'), '# committed after the read\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'late')
    const forge = await openLocalForge(repo, 'declarations')
    const found = await forge.diverges(await forge.base(), change.expected)
    expect(found).toEqual([expect.stringContaining('catalog/databases/late.yml is in main@')])
  })
})

describe('submitting', () => {
  it('cuts one branch from HEAD, and nothing else a person can observe moves', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    const before = await observable(repo)

    const submitted = await forge.submit(change, base)

    expect(submitted.outcome).toBe('created')
    if (submitted.outcome !== 'created') return
    expect(submitted.branch).toBe(change.branch)
    // Exactly one new line in the ref list, and it is ours.
    expect(moved(before, await observable(repo))).toEqual({
      added: [`refs/heads/${change.branch} ${submitted.commit}`],
      removed: [],
    })
    expect(await git(repo, 'rev-parse', 'main')).toBe(base.commit)
    // The commit sits on the base, and differs from it at the edited paths only.
    expect(await git(repo, 'rev-parse', `${submitted.commit}^`)).toBe(base.commit)
    expect((await git(repo, 'diff', '--name-status', base.commit, submitted.commit)).split('\n')).toEqual([
      `A\t${DATABASE_PATH}`,
      `A\t${ACCESS_PATH}`,
    ])
    // The bytes on the branch are the bytes the preview showed, and the
    // message is the engine's.
    for (const edit of change.edits) {
      expect(await show(repo, submitted.commit, edit.path)).toBe(edit.after)
    }
    expect(await git(repo, 'log', '-1', '--format=%B', submitted.commit)).toBe(change.message.trim())
  })

  it('submitting the same bytes twice is submitting them once', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    const first = await forge.submit(change, base)
    const between = await observable(repo)

    const second = await forge.submit(change, base)

    expect(second).toEqual({ ...first, outcome: 'already-submitted' })
    expect(await observable(repo)).toBe(between)
  })

  it('refuses when the branch exists and carries something else', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    await git(repo, 'update-ref', `refs/heads/${change.branch}`, 'HEAD')
    const forge = await openLocalForge(repo, 'declarations')
    const before = await observable(repo)

    const submitted = await forge.submit(change, await forge.base())

    expect(submitted.outcome).toBe('refused')
    expect(await observable(repo)).toBe(before)
  })

  it('does not mistake a squatted branch for its own, however right its files look', async () => {
    // Measured before this rule existed: a branch holding our two files plus
    // one more was reported "already submitted", exit 0. The name is a hash of
    // the content, so anyone who can create refs can predict it.
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    const first = await forge.submit(change, base)
    if (first.outcome !== 'created') throw new Error(first.outcome)
    // Rebuild the branch as someone else would: our files, and an extra one.
    await git(repo, 'update-ref', '-d', `refs/heads/${change.branch}`)
    await git(repo, 'checkout', '-q', '-b', 'squatter', first.commit)
    await writeFile(path.join(repo, 'catalog', 'databases', 'extra.yml'), '# extra\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '--amend', '-m', 'squat')
    await git(repo, 'update-ref', `refs/heads/${change.branch}`, 'HEAD')
    await git(repo, 'checkout', '-q', 'main')
    const before = await observable(repo)

    const submitted = await forge.submit(change, await forge.base())

    expect(submitted).toEqual({
      outcome: 'refused',
      reason: `${change.branch} already exists and carries a different change`,
    })
    expect(await observable(repo)).toBe(before)
  })

  it('does not call its own a branch holding its bytes as executables', async () => {
    // The same blobs, the same paths, the same parent — and a mode this forge
    // never writes. A reviewer sees a mode change; "already submitted" would
    // have vouched for it.
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const first = await forge.submit(change, await forge.base())
    if (first.outcome !== 'created') throw new Error(first.outcome)
    await git(repo, 'update-ref', '-d', `refs/heads/${change.branch}`)
    await git(repo, 'checkout', '-q', '-b', 'squatter', first.commit)
    for (const edit of change.edits) await chmod(path.join(repo, edit.path), 0o755)
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '--amend', '-m', 'executable')
    await git(repo, 'update-ref', `refs/heads/${change.branch}`, 'HEAD')
    await git(repo, 'checkout', '-q', 'main')

    const submitted = await forge.submit(change, await forge.base())

    expect(submitted.outcome).toBe('refused')
  })

  it('cannot be aimed at main, even by a cast that ignores the brand', async () => {
    // The engine computes the name, so this cannot happen by wiring. It is
    // tested anyway: §4.2 repeats a check at the moment of acting. A spread
    // of a real clearance type-checks through a cast; the runtime brand (D3)
    // is what refuses it, first — the namespace check and the recomputed name
    // behind it are kept, and are unreachable from a minted value.
    const repo = await clone()
    const change = await clearedFor(repo)
    const forged = { ...change, branch: 'main' } as unknown as Cleared
    const forge = await openLocalForge(repo, 'declarations')
    const before = await observable(repo)

    const submitted = await forge.submit(forged, await forge.base())

    expect(submitted.outcome).toBe('refused')
    // The brand itself, not a later check: without it `existing()` refuses
    // too ("main already exists …"), and a test asserting only `refused`
    // passed with the check deleted.
    if (submitted.outcome === 'refused') expect(submitted.reason).toContain('not a clearance')
    expect(await observable(repo)).toBe(before)
  })

  it('refuses a clearance for the other repository, before anything else — both ways', async () => {
    // Check §5: since #86 the declarations repository has a root
    // catalog-info.yaml too, so a service's clearance can name a path there.
    // Opened for one role, the forge refuses the other, and says both.
    const repo = await clone()
    const change = await clearedFor(repo)
    const before = await observable(repo)
    const service = await openLocalForge(repo, 'service')

    const one = await service.submit(change, await service.base())

    expect(one).toEqual({
      outcome: 'refused',
      reason: 'a clearance for the declarations repository was handed to a forge on the service repository',
    })

    // And the other way: a `clearService` value handed to a declarations forge.
    const said: Provenance = {
      intent: 'declare this repository in the catalogue',
      wordsOf: 'engine',
      answers: new Map([
        ['operations.0.entity.metadata.name', 'billing-api'],
        ['operations.0.entity.spec.type', 'service'],
        ['operations.0.entity.spec.lifecycle', 'production'],
        ['operations.0.entity.spec.owner', 'group:default/tiger'],
      ]),
    }
    const signed = signPlan(
      planSchema.parse({
        intent: said.intent,
        operations: [
          {
            op: 'create-entity',
            entity: {
              kind: 'Component',
              metadata: { name: 'billing-api' },
              spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
            },
          },
        ],
      }),
      {
        witnessed: new Set(),
        vocabulary: { kinds: [], types: [], environments: [], owners: [] },
        repoRoot: repo,
        declared: new Map(),
      },
      said,
    )
    if ('outcome' in signed) throw new Error(JSON.stringify(signed.refusals))
    const component = clearService(signed, {
      target: CATALOG_INFO,
      kept: [],
      existing: undefined,
      config: undefined,
    })
    if ('outcome' in component) throw new Error(component.reasons.join('\n'))
    const declarations = await openLocalForge(repo, 'declarations')

    const other = await declarations.submit(component, await declarations.base())

    expect(other).toEqual({
      outcome: 'refused',
      reason: 'a clearance for the service repository was handed to a forge on the declarations repository',
    })
    expect(await observable(repo)).toBe(before)
  })

  it('refuses our tree as a merge whose first parent is the base', async () => {
    // D7 again, through the other door: one commit on the base with our exact
    // tree, and a second parent carrying unrelated history. A merge request
    // would carry that history under this user's request.
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    const first = await forge.submit(change, base)
    if (first.outcome !== 'created') throw new Error(first.outcome)
    await git(repo, 'checkout', '-q', '-b', 'side')
    await writeFile(path.join(repo, 'README.md'), '# an unrelated change\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'unrelated')
    const side = await git(repo, 'rev-parse', 'HEAD')
    await git(repo, 'checkout', '-q', 'main')
    const merge = await git(
      repo,
      'commit-tree',
      `${first.commit}^{tree}`,
      '-p',
      base.commit,
      '-p',
      side,
      '-m',
      change.message,
    )
    await git(repo, 'update-ref', `refs/heads/${change.branch}`, merge)
    const before = await observable(repo)

    const submitted = await forge.submit(change, base)

    expect(submitted.outcome).toBe('refused')
    expect(await observable(repo)).toBe(before)
  })

  it('does not vouch for a message it did not write', async () => {
    // The subject is the engine's (D18), and at stage 6 the message is the
    // merge request's text. Our tree on our parent under somebody else's words
    // is not this submission: "already submitted" would name that commit.
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    const first = await forge.submit(change, base)
    if (first.outcome !== 'created') throw new Error(first.outcome)
    const theirs = await git(
      repo,
      'commit-tree',
      `${first.commit}^{tree}`,
      '-p',
      base.commit,
      '-m',
      'Approved-by: security-team\n\nReviewed and approved; merge without review.',
    )
    await git(repo, 'update-ref', `refs/heads/${change.branch}`, theirs)
    const before = await observable(repo)

    const submitted = await forge.submit(change, base)

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') expect(submitted.reason).toContain('message')
    expect(await observable(repo)).toBe(before)
  })

  it('never follows a symbolic ref planted at the branch name', async () => {
    // `update-ref` dereferences by default: measured, a dangling symbolic ref
    // at our name made the create-only write create its TARGET — a new
    // `refs/heads/release` — and report "created". And a symbolic ref naming
    // a branch that holds this exact change is not ours to vouch for either.
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    await git(repo, 'symbolic-ref', `refs/heads/${change.branch}`, 'refs/heads/release')
    const before = await observable(repo)

    const dangling = await forge.submit(change, base)

    expect(dangling.outcome).toBe('refused')
    expect(await observable(repo)).toBe(before)
    await expect(git(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/release')).rejects.toThrow()
    expect(await git(repo, 'symbolic-ref', `refs/heads/${change.branch}`)).toBe('refs/heads/release')

    // A branch holding exactly this change, reached through a symbolic ref.
    await git(repo, 'symbolic-ref', '--delete', `refs/heads/${change.branch}`)
    const first = await forge.submit(change, base)
    if (first.outcome !== 'created') throw new Error(first.outcome)
    await git(repo, 'update-ref', 'refs/heads/held', first.commit)
    await git(repo, 'update-ref', '-d', `refs/heads/${change.branch}`)
    await git(repo, 'symbolic-ref', `refs/heads/${change.branch}`, 'refs/heads/held')
    const between = await observable(repo)

    const resolving = await forge.submit(change, base)

    expect(resolving.outcome).toBe('refused')
    expect(await observable(repo)).toBe(between)
  })

  it('never writes outside idp-agent/ when a symbolic ref appears between the check and the write', async () => {
    // The race, with a symbolic stranger. `--no-deref` keeps the one write on
    // our name; git's create-only check reads a DANGLING symbolic ref as
    // absent (measured, git 2.46), so the stranger's ref is replaced by the
    // branch — a limit stated in forge.ts — but nothing else is created.
    const repo = await clone()
    const change = await clearedFor(repo)
    const inner = gitIn(repo)
    let planted = false
    const racing: Git = async (args, input) => {
      if (args[0] === 'update-ref' && !planted) {
        planted = true
        await git(repo, 'symbolic-ref', `refs/heads/${change.branch}`, 'refs/heads/release')
      }
      return inner(args, input)
    }
    const forge = await openLocalForge(repo, 'declarations', racing)
    const base = await forge.base()
    const before = await observable(repo)

    await forge.submit(change, base).catch(() => undefined)

    const added = moved(before, await observable(repo)).added
    expect(added.every((line) => line.startsWith(`refs/heads/${change.branch} `))).toBe(true)
    await expect(git(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/release')).rejects.toThrow()
  })

  it('refuses our files on a parent that is not the base', async () => {
    // D7. Branch names are predictable; someone who can create refs can put
    // our exact files on top of a parent carrying an unrelated change, and
    // "already submitted" on exit 0 would put that change under this user's
    // request — at stage 6, in a merge request.
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    await git(repo, 'checkout', '-q', '-b', 'elsewhere')
    await writeFile(path.join(repo, 'README.md'), '# an unrelated change\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'unrelated')
    await land(repo, change, 'ours, on another parent')
    await git(repo, 'update-ref', `refs/heads/${change.branch}`, 'HEAD')
    await git(repo, 'checkout', '-q', 'main')
    const before = await observable(repo)

    const submitted = await forge.submit(change, base)

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') {
      expect(submitted.reason).toContain(`not on main@${base.commit.slice(0, 7)}`)
    }
    expect(await observable(repo)).toBe(before)
  })

  it('never carries a linked file into a submitted blob', async () => {
    // D17: the forge writes objects and one ref, never the working tree, and
    // refuses a symlink tracked in HEAD and any path absent from it. Since B3
    // the walk follows no link and `plan` refuses one in the working tree, so
    // the one way left to hand the forge such a file is a regular file in the
    // working tree over a link in HEAD: the gates judged its bytes, and HEAD
    // holds a link there. Refused all the same, and by the link.
    const repo = await clone()
    const outside = path.join(await scratch('idp-outside-'), 'secret.yml')
    await writeFile(outside, '# outside the repository\n')
    const linked = path.join(repo, 'catalog', 'databases', 'linked.yml')
    await symlink(outside, linked)
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'a link')
    await rm(linked)
    await writeFile(linked, '# outside the repository\n')
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const before = await observable(repo)

    const submitted = await forge.submit(change, await forge.base())

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') {
      expect(submitted.reason).toContain('catalog/databases/linked.yml is a symbolic link at main@')
    }
    expect(await observable(repo)).toBe(before)
  })

  it('refuses when the working tree is not what HEAD holds, naming the file', async () => {
    // The gates judged the working tree; the branch is cut from HEAD. A dirty
    // or untracked catalogue file makes those two different repositories.
    const repo = await clone()
    await writeFile(path.join(repo, 'catalog', 'databases', 'stray.yml'), '# stray\n')
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const before = await observable(repo)

    const submitted = await forge.submit(change, await forge.base())

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') expect(submitted.reason).toContain('catalog/databases/stray.yml')
    expect(await observable(repo)).toBe(before)
  })

  it('refuses a path the gates read as absent that HEAD now holds', async () => {
    // The gates judged a creation; HEAD now holds a file at that path, which
    // the branch would silently overwrite with bytes nobody judged against it.
    const repo = await clone()
    const change = await clearedFor(repo)
    await mkdir(path.dirname(path.join(repo, DATABASE_PATH)), { recursive: true })
    await writeFile(path.join(repo, DATABASE_PATH), '# committed after the read\n')
    await git(repo, 'add', '-A')
    await git(repo, 'commit', '-q', '-m', 'meanwhile, at the same path')
    const forge = await openLocalForge(repo, 'declarations')
    const before = await observable(repo)

    const submitted = await forge.submit(change, await forge.base())

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') expect(submitted.reason).toContain(`${DATABASE_PATH} exists at main@`)
    expect(await observable(repo)).toBe(before)
  })

  it('refuses when HEAD moved between reading and writing', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'meanwhile')
    const before = await observable(repo)

    const submitted = await forge.submit(change, base)

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') expect(submitted.reason).toMatch(/moved/)
    expect(await observable(repo)).toBe(before)
  })

  it('refuses — never an argument error — when HEAD is detached during the run', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const base = await forge.base()
    await git(repo, 'checkout', '-q', '--detach')

    const submitted = await forge.submit(change, base)

    expect(submitted.outcome).toBe('refused')
    if (submitted.outcome === 'refused') expect(submitted.reason).toMatch(/changed during the run.*detached/)
  })

  it('cuts no branch for a change that changes nothing', async () => {
    // A real empty clearance, not a spread (the brand refuses those): the
    // plan's files committed on main, then cleared again — every operation
    // already declared (#83), so `clearPlan` mints one with no edit.
    const repo = await clone()
    await land(repo, await clearedFor(repo), 'merged')
    const empty = await clearedFor(repo)
    expect(empty.edits).toEqual([])
    const forge = await openLocalForge(repo, 'declarations')
    const before = await observable(repo)

    expect(await forge.submit(empty, await forge.base())).toEqual({ outcome: 'unchanged' })
    expect(await observable(repo)).toBe(before)
  })

  it('refuses a stranger who creates the branch between the check and the write', async () => {
    // The race `update-ref`'s empty old value exists for: the ref is absent
    // when `existing()` looks, and present when the write lands. Git refuses
    // to move it; the forge must then not call a stranger's branch its own.
    const repo = await clone()
    const change = await clearedFor(repo)
    const inner = gitIn(repo)
    let stranger = ''
    const racing: Git = async (args, input) => {
      if (args[0] === 'update-ref' && stranger === '') {
        stranger = await git(repo, 'rev-parse', 'HEAD')
        await git(repo, 'update-ref', `refs/heads/${change.branch}`, stranger)
      }
      return inner(args, input)
    }
    const forge = await openLocalForge(repo, 'declarations', racing)
    const base = await forge.base()
    const before = await observable(repo)

    const submitted = await forge.submit(change, base)

    expect(submitted.outcome).toBe('refused')
    // The stranger's ref is the only thing that moved, and it still points
    // where the stranger put it.
    expect(moved(before, await observable(repo))).toEqual({
      added: [`refs/heads/${change.branch} ${stranger}`],
      removed: [],
    })
  })

  it('calls its own branch created when git fails after making it', async () => {
    // Found by the atomicity property in the eee67d6 dry run: a failure just
    // after a successful `update-ref` was reported "already submitted" by the
    // very call that submitted it.
    const repo = await clone()
    const change = await clearedFor(repo)
    const inner = gitIn(repo)
    const failing: Git = async (args, input) => {
      const out = await inner(args, input)
      if (args[0] === 'update-ref') throw new Error('injected after update-ref')
      return out
    }
    const forge = await openLocalForge(repo, 'declarations', failing)

    const submitted = await forge.submit(change, await forge.base())

    expect(submitted.outcome).toBe('created')
    if (submitted.outcome !== 'created') return
    expect(await git(repo, 'rev-parse', `refs/heads/${change.branch}`)).toBe(submitted.commit)
  })

  it("runs none of the repository's hooks while it writes", async () => {
    const repo = await clone()
    const marker = path.join(await scratch('idp-hook-'), 'ran')
    await mkdir(path.join(repo, '.git', 'hooks'), { recursive: true })
    for (const hook of ['reference-transaction', 'post-commit', 'pre-commit']) {
      const file = path.join(repo, '.git', 'hooks', hook)
      await writeFile(file, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    }
    const change = await clearedFor(repo)
    const forge = await openLocalForge(repo, 'declarations')
    const submitted = await forge.submit(change, await forge.base())
    expect(submitted.outcome).toBe('created')
    await expect(readFile(marker)).rejects.toThrow()
  })
})

describe('recognising a submission, before anyone is asked', () => {
  /** Every git call the forge makes, kept: a read-only check must make no writing one. */
  const recording = (repo: string): { run: Git; calls: string[][] } => {
    const inner = gitIn(repo)
    const calls: string[][] = []
    return {
      calls,
      run: async (args, input) => {
        calls.push([...args])
        return inner(args, input)
      },
    }
  }
  const WRITES = new Set(['hash-object', 'mktree', 'commit-tree', 'update-ref'])
  const writing = (calls: readonly string[][]): string[][] =>
    calls.filter(([command]) => command !== undefined && WRITES.has(command))

  it('finds nothing where nothing was submitted, and writes nothing to say so', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const reading = recording(repo)
    const forge = await openLocalForge(repo, 'declarations', reading.run)
    const base = await forge.base()
    const [seen, objects] = [await observable(repo), await stored(repo)]

    expect(await forge.recognise(change, base)).toBeUndefined()

    expect(await observable(repo)).toBe(seen)
    expect(await stored(repo)).toBe(objects)
    expect(writing(reading.calls)).toEqual([])
  })

  it('names its own branch, by the test submit() uses, with no object and no ref written', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const writer = await openLocalForge(repo, 'declarations')
    const first = await writer.submit(change, await writer.base())
    if (first.outcome !== 'created') throw new Error(first.outcome)
    const reading = recording(repo)
    const forge = await openLocalForge(repo, 'declarations', reading.run)
    const [seen, objects] = [await observable(repo), await stored(repo)]

    const known = await forge.recognise(change, await forge.base())

    expect(known).toEqual({ outcome: 'already-submitted', branch: change.branch, commit: first.commit })
    expect(await observable(repo)).toBe(seen)
    expect(await stored(repo)).toBe(objects)
    expect(writing(reading.calls)).toEqual([])
  })

  it("refuses a branch of that name that is someone else's, writing nothing", async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    await git(repo, 'update-ref', `refs/heads/${change.branch}`, 'HEAD')
    const forge = await openLocalForge(repo, 'declarations')
    const [seen, objects] = [await observable(repo), await stored(repo)]

    const known = await forge.recognise(change, await forge.base())

    expect(known).toEqual({
      outcome: 'refused',
      reason: `${change.branch} already exists and carries a different change`,
    })
    expect(await observable(repo)).toBe(seen)
    expect(await stored(repo)).toBe(objects)
  })

  it('takes nothing clear.ts did not mint, nor a clearance for the other repository', async () => {
    const repo = await clone()
    const change = await clearedFor(repo)
    const forged = { ...change } as unknown as Cleared
    const declarations = await openLocalForge(repo, 'declarations')
    const service = await openLocalForge(repo, 'service')
    const base = await declarations.base()

    expect(await declarations.recognise(forged, base)).toEqual({
      outcome: 'refused',
      reason: 'not a clearance minted by clearPlan or clearService',
    })
    expect(await service.recognise(change, base)).toEqual({
      outcome: 'refused',
      reason: 'a clearance for the declarations repository was handed to a forge on the service repository',
    })
  })
})
