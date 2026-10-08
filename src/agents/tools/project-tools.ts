import { z } from 'zod'
import type { ProjectSnapshot } from '../../context/project-fs/types.js'
import { ownerRefSchema } from '../../core/schemas/entity.js'
import { proposedName, unknownSchema } from '../../core/schemas/plan.js'
import type { ModelToolCall, ModelToolSpec } from '../../llm/client.js'
import { refused, type ToolOutcome } from './graph-tools.js'

/**
 * A value, or an explicitly undetermined one. `unknownSchema` is reused rather
 * than restated: `findUnknowns` recognises exactly that shape, and a second
 * spelling of "I do not know" would be a value as far as it is concerned —
 * a plan holding it would apply (design 5.4).
 *
 * The return type is left to inference, unlike `plan.ts`'s own `or`. Widening
 * to `z.ZodType` there erases the union and `z.infer` yields `unknown`, which a
 * `Plan` survives because the engine only ever validates it whole. The Architect
 * reads these fields one at a time, so it does not survive here.
 */
const or = <T extends z.ZodType>(schema: T) => z.union([schema, unknownSchema])

/**
 * What the Architect needs about ONE application repository in order to propose
 * entities, and nothing else. Every field is consumed by a field of
 * `proposedComponentSchema` or `proposedResourceSchema`; a fact nobody consumes
 * is a fact nobody checks, and it still travels to a model.
 *
 *   name          → proposedComponentSchema.metadata.name, so the same pattern
 *   type          → proposedComponentSchema.spec.type ("service", "library")
 *   lifecycle     → proposedComponentSchema.spec.lifecycle — the one field whose
 *                   plausible default, "production", is the dangerous one
 *   runtime       → separates a service from a library, and is the evidence the
 *                   Architect has for spec.type
 *   owner         → spec.owner on both proposals, and owner is who authorises
 *   forgeHandle   → not an owner; see the comment on the field
 *
 * Three fields are deliberately ABSENT, and each absence is a guarantee:
 *
 *   dependencies      what a service installs is stage 8's discovery's: a
 *                     finding with its file and line, read by a parser, which
 *                     reaches no model. A model's list of the packages it saw
 *                     was a second, unverified reading of the same files, and
 *                     the strict schema now refuses one.
 *   metadata.env      an environment is a property of the REQUEST, not of a
 *                     repository. The `environment-mismatch` policy (design 6.1)
 *                     exists to refuse an environment the intent did not name,
 *                     and sourcing one here would launder an inference past it.
 *   metadata.description
 *                     optional in the proposal, so an absent one costs nothing,
 *                     and the field would be a second free-text channel out of a
 *                     repository and into a plan, for no field that needs it.
 *
 * What this does NOT give the Architect: any assurance the values are true.
 * These are values a model composed from files, not identifiers an engine
 * returned. What the engine does hold them to is the files the model was
 * handed (`project-witness.ts`): a value no file `read_file` returned before
 * the report states, by its field's rule, is withdrawn into an unknown with the
 * engine's reason, and said. A kept value is "some file says so", never
 * "true" — a file can state a wrong one. The reason a model writes for a field
 * it marks unknown is not a value and is held to nothing, so it reaches no other
 * model: the Architect reads the engine's fixed reason for that field
 * (`FACT_UNKNOWN`, `architect.ts`).
 */
export const projectFactsSchema = z.strictObject({
  name: or(proposedName),
  type: or(z.string().min(1).max(63)),
  lifecycle: or(z.enum(['experimental', 'production', 'deprecated'])),
  runtime: or(z.string().min(1).max(63)),
  owner: or(ownerRefSchema),
  /**
   * A forge handle — `@user` or `@org/team` — reported verbatim and labelled as
   * itself. `scaffold/codeowners.ts` refuses this round trip in the other
   * direction, and the reason is the same one layer up: `@acme/platform` and
   * `group:default/platform` are different namespaces, one flag cannot be both,
   * and the namespace does not survive the translation. Deriving `owner` from
   * this would invent an entity reference nobody declared — and an owner is who
   * gets to authorise.
   *
   * Not validated against `isForgeHandle`: a CODEOWNERS line may hold an email
   * address just as legally, and the point of this field is to report what was
   * written, not to recognise it. Nothing downstream may put it in `spec.owner`.
   */
  forgeHandle: or(z.string().min(1).max(200)),
})

export type ProjectFacts = z.infer<typeof projectFactsSchema>

/** A file `read_file` returned to the model: its path in the snapshot and the text it was handed. */
export interface ReadFile {
  readonly path: string
  readonly text: string
}

/** The terminal tool. Named once so the loop and the specs cannot disagree. */
export const REPORT_TOOL = 'report_facts'

const listInputSchema = z.strictObject({
  pathContains: z.string().min(1).max(200).optional(),
})

const readInputSchema = z.strictObject({
  path: z.string().min(1).max(512),
})

/**
 * A path as `read_file` compares it: composed (NFC), with the spellings of one
 * file taken out — a leading `./`, a doubled slash, a `.` segment, a `..` that
 * climbs back down. `undefined` for a path that starts at `/` or climbs above
 * the root: no file of the snapshot is there, and none is looked for.
 *
 * Only the spelling moves. It is still an exact match on what it spells —
 * `package.jso` is not `package.json` — for the reason given where it is used.
 */
function normalised(path: string): string | undefined {
  if (path.startsWith('/')) return undefined
  const segments: string[] = []
  for (const segment of path.normalize('NFC').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.pop() === undefined) return undefined
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

/** What `read_file` says beside a text that is not all the file holds. */
const UNDECODABLE =
  'not UTF-8: each byte sequence that does not decode reads as U+FFFD, so this text is not ' +
  'all the file says'

const failed = (tool: string, error: z.ZodError): ToolOutcome =>
  // Returned, not thrown: the loop has to be able to continue after a bad call,
  // and the model has to be able to read what was wrong with it.
  refused(`${tool}: ${error.issues[0]?.message ?? 'invalid arguments'}`)

/**
 * The Inspector's read tools, closed over a snapshot that was taken before any
 * of this ran. There is no `path` argument that reaches a filesystem and no code
 * path from here to one: `readProject` decided containment, exclusion and the
 * three caps on the other side of the line (design § 6), and this side only
 * looks things up in what came back.
 *
 * `snapshot.root` is never read by anything below. It is an absolute path on the
 * user's machine, it answers no question the Inspector is asked, and a repository
 * checked out at `~/work/billing-api` would otherwise hand a model a very
 * convincing name that no file in it states.
 */
export function buildProjectTools(snapshot: ProjectSnapshot): {
  specs: ModelToolSpec[]
  run(call: ModelToolCall): ToolOutcome
  /** The files read_file returned, in the order first returned, each once. Never a path list_files gave. */
  read(): readonly ReadFile[]
} {
  /**
   * What the model was handed, and nothing else: a refused call — an excluded
   * file, a near miss, a call with no path, a manifest written into the
   * arguments — is no read, and a path `list_files` returned is a name nobody
   * chose. The witness reads this (`project-witness.ts`).
   */
  const returned: ReadFile[] = []

  const specs: ModelToolSpec[] = [
    {
      name: 'list_files',
      description:
        'List the files this snapshot holds, as project-relative paths. Optionally filter ' +
        'to paths containing a fragment. Files excluded from the snapshot are not listed ' +
        'here; they were named to you at the start and no tool can reach them.',
      parameters: listInputSchema,
    },
    {
      name: 'read_file',
      description:
        'Read one file by its exact project-relative path, as listed by list_files. It ' +
        'never guesses a near match. If the path was excluded from the snapshot it returns ' +
        'the reason it was excluded, which is not the same as the file not existing.',
      parameters: readInputSchema,
    },
    {
      name: REPORT_TOOL,
      description:
        'End the inspection. Every field is required: give a value the files state, or ' +
        '{"unknown": "<why>"} naming what you looked for and did not find. Never omit a ' +
        'field, and never fill one with a plausible value. You must call this to finish.',
      parameters: projectFactsSchema,
    },
  ]

  return {
    specs,

    read: () => [...returned],

    run(call: ModelToolCall): ToolOutcome {
      if (call.name === 'list_files') {
        const parsed = listInputSchema.safeParse(call.args)
        if (!parsed.success) return failed('list_files', parsed.error)
        const fragment = parsed.data.pathContains
        const paths = snapshot.files
          .filter((file) => fragment === undefined || file.path.includes(fragment))
          .map((file) => file.path)
        // No second cap, and no truncation to state. `readProject` already
        // stopped at its file cap and said so in `truncated`, which the opening
        // message carries; a cap here would be a second place for the same bound
        // to drift, and it would cut silently where that one does not.
        return { result: { paths }, rows: paths.length, truncated: 0 }
      }

      if (call.name === 'read_file') {
        const parsed = readInputSchema.safeParse(call.args)
        if (!parsed.success) return failed('read_file', parsed.error)
        const wanted = normalised(parsed.data.path)
        const named = (path: string): boolean => path.normalize('NFC') === wanted

        const file = snapshot.files.find((candidate) => named(candidate.path))
        // Exact match only. No nearest path, deliberately — the same refusal
        // `get_entity` makes, for the same reason (design 4.1): a near miss read
        // as the file that was asked for is a fact attributed to the wrong file.
        // `./package.json` is not a near miss: it spells the same path.
        if (file !== undefined) {
          if (!returned.some((seen) => seen.path === file.path)) {
            returned.push({ path: file.path, text: file.text })
          }
          return {
            result: {
              path: file.path,
              text: file.text,
              ...(file.undecodable === true ? { encoding: UNDECODABLE } : {}),
            },
            rows: 1,
            truncated: 0,
          }
        }

        const excluded = snapshot.skipped.find((entry) => named(entry.path))
        if (excluded !== undefined) {
          // The reason, not "no such file". A model told the manifest is missing
          // goes looking elsewhere; a model told it was excluded knows the fact
          // is unknowable from here and reports it unknown, which is correct.
          return refused(`not read: ${excluded.reason}`)
        }

        // A folder set aside is named once, never file by file, so a file in
        // it matches no entry: the folder, and why, is what the model is told.
        const holds = (entry: { path: string }): boolean =>
          entry.path !== '.' && wanted?.startsWith(`${entry.path.normalize('NFC')}/`) === true
        const under = snapshot.skipped.find(holds)
        if (under !== undefined) {
          return refused(`not read: it is under ${under.path}/, ${under.reason}`)
        }

        // A cap names the file it stopped at and counts the rest: a file past
        // it is in no list, and "no file" would be a claim nobody can make.
        return refused(
          snapshot.truncated
            ? 'this snapshot holds no file at that path; a cap stopped the read, and a file ' +
                'past it is neither read nor listed'
            : 'this snapshot holds no file at that path',
        )
      }

      if (call.name === REPORT_TOOL) {
        // Returned as given. The loop validates it; a tool that vouched for the
        // model's own report would be vouching for nothing.
        return { result: call.args, rows: 0, truncated: 0 }
      }

      return refused(`unknown tool "${call.name}"`)
    },
  }
}
