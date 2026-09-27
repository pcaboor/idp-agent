import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = path.resolve(import.meta.dirname, '../../src')

interface Import {
  file: string
  specifier: string
}

/** What TypeScript compiles: `.ts`, and the `.mts` and `.cts` that NodeNext reads as ESM and CommonJS. */
const SOURCE = /\.[mc]?ts$/

/**
 * Every source file under `dir`. A folder that is not there throws, as does
 * every read below: each rule is a filter over what these return, and an empty
 * read passes every filter, so a renamed layer used to leave its rules green.
 */
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(full)
      return SOURCE.test(entry.name) ? [full] : []
    }),
  )
  return nested.flat()
}

/**
 * Static imports and re-exports, plus dynamic import() and require(). The
 * static pattern stops at `from`: it used to read on to the next quote, so
 * `export const CONFIG_FILE = '.idp-agent.yml'` was an import of a file, which
 * only a rule that resolves imports could notice.
 */
const PATTERNS = [
  /^\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm,
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g,
]

async function importsOf(file: string): Promise<Import[]> {
  const content = await readFile(file, 'utf8')
  const found: Import[] = []
  for (const pattern of PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1] ?? match[2]
      if (specifier !== undefined) {
        found.push({ file: path.relative(SOURCE_ROOT, file), specifier })
      }
    }
  }
  return found
}

async function importsUnder(dir: string): Promise<Import[]> {
  const nested = await Promise.all((await sourceFiles(dir)).map(importsOf))
  return nested.flat()
}

/**
 * The file a relative specifier names — `.js` written for the `.ts` it is
 * compiled from, `.mjs` for `.mts`, `.cjs` for `.cts` — or an error naming
 * both ends. An import that resolves nowhere used to be walked as an empty
 * file, and whatever it would have reached was never seen.
 */
async function resolved(from: string, specifier: string): Promise<string> {
  const target = path.resolve(path.dirname(from), specifier.replace(/\.([mc]?)js$/, '.$1ts'))
  const found = await stat(target).catch(() => undefined)
  if (found?.isFile() !== true) {
    throw new Error(`${path.relative(SOURCE_ROOT, from)} imports ${specifier}, which is no file`)
  }
  return target
}

/**
 * Every import reachable from an entry file, not only the ones written in it.
 * Relative specifiers are resolved and walked; a bare specifier is recorded and
 * not walked. Grepping one directory would let agents/ -> llm/client ->
 * recording -> node:fs pass, while SECURITY.md claims there is no code path from
 * an agent to the disk. This is that claim, made checkable.
 */
async function closureOf(entry: string, seen = new Set<string>()): Promise<Import[]> {
  if (seen.has(entry)) return []
  seen.add(entry)

  const found: Import[] = []
  for (const imported of await importsOf(entry)) {
    found.push(imported)
    if (!imported.specifier.startsWith('.')) continue
    found.push(...(await closureOf(await resolved(entry, imported.specifier), seen)))
  }
  return found
}

const FS_OR_PROCESS = /^(node:)?(fs|fs\/promises|child_process|module|worker_threads)$/

/**
 * Names that hand over the whole module: fs's `promises`, a `default` taken by
 * name, and anything from `module` or `worker_threads` — a `createRequire` or a
 * `Worker` loads fs at run time, with no specifier left to read.
 */
const whole = (specifier: string, name: string): boolean =>
  name === 'promises' || name === 'default' || /(^|:)(module|worker_threads)$/.test(specifier)

/**
 * What a module takes from fs and child_process, name by name, `*` for the
 * whole module — a namespace, a default import, a re-export of everything, a
 * dynamic import or a require, and the names `whole` lists. Types are left out: `import type` is erased.
 *
 * The specifier alone cannot tell `readFile` from `writeFile`, and the rule
 * that names who may write needs exactly that.
 */
async function diskNamesOf(file: string): Promise<{ specifier: string; name: string }[]> {
  const content = await readFile(file, 'utf8')
  const found: { at: number; specifier: string; name: string }[] = []
  // The clause never crosses into another statement: `export type X = {…}`
  // holds no quote, and was read as the clause of the import after it.
  const statement =
    /^\s*(?:import|export)\s+(type\s+)?((?:(?!\b(?:import|export)\b)[^'";])*?)\s*from\s*['"]([^'"]+)['"]/gm
  for (const match of content.matchAll(statement)) {
    const [, typeOnly, clause = '', specifier = ''] = match
    if (typeOnly !== undefined || !FS_OR_PROCESS.test(specifier)) continue
    const braces = /\{([^}]*)\}/.exec(clause)
    const outside = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim()
    // `* as fs`, `disk` or `export *`: the whole module.
    if (outside !== '') found.push({ at: match.index, specifier, name: '*' })
    for (const part of braces?.[1]?.split(',') ?? []) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim() ?? ''
      if (name === '' || name.startsWith('type ')) continue
      found.push({ at: match.index, specifier, name: whole(specifier, name) ? '*' : name })
    }
  }
  for (const match of content.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1] ?? ''
    if (FS_OR_PROCESS.test(specifier)) found.push({ at: match.index, specifier, name: '*' })
  }
  return found.sort((a, b) => a.at - b.at).map(({ specifier, name }) => ({ specifier, name }))
}

/** Every fs function that can change the disk, `open` included: its flags decide. */
const WRITING =
  /^(writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|rename|cp|copyFile|symlink|link|truncate|chmod|lchmod|chown|lchown|utimes|lutimes|createWriteStream|open|write|writev)(Sync)?$/

const MODEL_SDK = /^ai$|^@ai-sdk\//
const DISK =
  /^(node:)?(fs|fs\/promises|child_process|worker_threads|module)$|^(simple-git|isomorphic-git|nodegit)$/
const NETWORK = /^(node:)?(http|https|net|dgram|tls)$|^(undici|axios|node-fetch|got)$/

/** A file's name under `root`, with `/` whatever the platform. */
const nameUnder = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/')

/**
 * Source with its comments taken out. A scanner, not a pattern: a `//` in a
 * URL string, or the `/*` of `'*\/*'`, starts no comment, and a pattern that
 * took them for one dropped the code after them unread. Strings, templates
 * (their `${…}` read as code) and regular expressions are kept as written;
 * whether a `/` opens a regular expression is told by what comes before it,
 * as a tokenizer tells it.
 */
function stripped(text: string): string {
  let out = ''
  let at = 0
  let depth = 0
  // The brace depth each open `${` of a template returns to, innermost last.
  const templates: number[] = []

  /** From inside a template to its closing backtick, or to its next `${`. */
  const templateTail = (): void => {
    while (at < text.length) {
      const c = text[at]
      if (c === '\\') {
        out += text.slice(at, at + 2)
        at += 2
        continue
      }
      out += c
      at += 1
      if (c === '`') return
      if (c === '$' && text[at] === '{') {
        out += '{'
        at += 1
        templates.push(depth)
        depth += 1
        return
      }
    }
  }

  /** A `/` after a value divides; anywhere else it opens a regular expression. */
  const regexMayStart = (): boolean => {
    const before = out.trimEnd()
    const last = before.at(-1)
    if (last === undefined) return true
    if (/[\w$]/.test(last)) {
      return /(?:^|[^\w$.])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(before)
    }
    return !/[)\]}'"`]/.test(last)
  }

  while (at < text.length) {
    const c = text[at]
    const next = text[at + 1]
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', at)
      at = end === -1 ? text.length : end
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', at + 2)
      at = end === -1 ? text.length : end + 2
      out += ' '
    } else if (c === "'" || c === '"') {
      let end = at + 1
      while (end < text.length && text[end] !== c && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1
      out += text.slice(at, end + 1)
      at = end + 1
    } else if (c === '`') {
      out += c
      at += 1
      templateTail()
    } else if (c === '}' && templates.length > 0 && depth - 1 === templates.at(-1)) {
      templates.pop()
      depth -= 1
      out += c
      at += 1
      templateTail()
    } else if (c === '/' && regexMayStart()) {
      let end = at + 1
      let inClass = false
      while (end < text.length && text[end] !== '\n' && (inClass || text[end] !== '/')) {
        if (text[end] === '\\') end += 1
        else if (text[end] === '[') inClass = true
        else if (text[end] === ']') inClass = false
        end += 1
      }
      out += text.slice(at, end + 1)
      at = end + 1
    } else {
      if (c === '{') depth += 1
      else if (c === '}') depth -= 1
      out += c
      at += 1
    }
  }
  return out
}

/**
 * Any mention of the global, not only a call: `const f = fetch; f(url)`,
 * `fetch.call(…)`, `Reflect.apply(fetch, …)` and `global.fetch` all name it.
 * The one exemption is a `fetch` right after an escaped dot, `\.fetch`, which
 * is text inside a regular expression: `project-fs/secrets.ts`'s `ENV\.fetch\(`.
 */
const NAMES_FETCH = /(?<!\\\.)\bfetch\b/
const NAMES_A_GLOBAL_WAY_OUT = /\bglobalThis\b|\bglobal\b|\bXMLHttpRequest\b|\bWebSocket\b/

/** The one module that calls the `fetch` it is handed, as `options.catalogueFetch(`. */
const TRANSPORT = 'context/backstage/transport.ts'

/**
 * What context/ under `root` does that the first `fetch` rule refuses. `fetch`
 * needs no import, so NETWORK cannot see it (the limit SECURITY.md states),
 * which is why the trace/ rule already refuses the word. The transport is
 * handed a `catalogueFetch` and calls it as `options.catalogueFetch(`; no
 * other file calls one. And a road out by import is refused as well: a
 * network module, statically or at run time, and a module loaded at run time
 * by a name the source does not spell.
 */
async function fetchOffences(root: string): Promise<string[]> {
  const offending: string[] = []
  for (const file of await sourceFiles(path.join(root, 'context'))) {
    const name = nameUnder(root, file)
    const code = stripped(await readFile(file, 'utf8'))
    if (NAMES_A_GLOBAL_WAY_OUT.test(code)) offending.push(`${name} names a global way out`)
    if (NAMES_FETCH.test(code)) offending.push(`${name} names fetch`)
    for (const pattern of PATTERNS) {
      for (const match of code.matchAll(pattern)) {
        const specifier = match[1] ?? match[2] ?? ''
        if (NETWORK.test(specifier)) offending.push(`${name} imports ${specifier}`)
      }
    }
    for (const match of code.matchAll(/\b(?:import|require)\s*\(([^)]*)\)/g)) {
      const argument = (match[1] ?? '').trim()
      if (!/^(['"])[^'"]*\1$/.test(argument)) offending.push(`${name} loads ${argument} at run time`)
    }
    const calls = name === TRANSPORT ? /(?<!\boptions\.)\bcatalogueFetch\s*\(/ : /\bcatalogueFetch\s*\(/
    if (calls.test(code)) offending.push(`${name} calls a catalogueFetch`)
  }
  return offending
}

/**
 * What the closure of agents/ under `root` reaches that the second rule
 * refuses: a module of context/backstage/, or a file naming `fetch` or a
 * global way out. The catalogue is read before any model is called, and this
 * is what keeps a model's words from ever becoming a request.
 */
async function agentsReachOffences(root: string): Promise<string[]> {
  const offending: string[] = []
  const reached = new Set<string>()
  for (const entry of await sourceFiles(path.join(root, 'agents'))) {
    for (const { specifier } of await closureOf(entry, reached)) {
      if (/(^|\/)backstage\//.test(specifier)) offending.push(`agents/ reaches ${specifier}`)
    }
  }
  for (const file of [...reached].sort()) {
    const name = nameUnder(root, file)
    const code = stripped(await readFile(file, 'utf8'))
    if (NAMES_A_GLOBAL_WAY_OUT.test(code)) offending.push(`${name} names a global way out`)
    if (NAMES_FETCH.test(code)) offending.push(`${name} names fetch`)
  }
  return offending
}

/**
 * Every module that may start a process, with how many calls of a
 * child_process function it makes and the function whose result each call is
 * given as `env`. They are the only modules the rule on writers lets import
 * child_process, so a module added there is stated here too.
 */
const SPAWNS: Readonly<Record<string, { readonly calls: number; readonly env: string }>> = {
  // `git()`, which every git command of the Inspector goes through.
  'context/project-fs/snapshot.ts': { calls: 1, env: 'gitEnvironment' },
}

/**
 * Every mention of a child_process function, not only a call: a value passed
 * on (`promisify(execFile)`) or a namespace's (`cp.execFile(`) starts a
 * process all the same. The one exemption is `.exec`, a regular expression's
 * method: the module cannot hold child_process's under a namespace, which
 * `spawnOffences` refuses.
 */
const NAMES_A_PROCESS = /(?<![\w$])(?:execFile|execFileSync|spawn|spawnSync|execSync|fork)\b|(?<![\w$.])exec\b/g

/** An `import` of child_process, the one place its functions are named without being used. */
const IMPORTS_CHILD_PROCESS = /^\s*import\s+([^'";]*?)\s*from\s*['"]((?:node:)?child_process)['"];?/gm

/** From the bracket at `open` to the one that closes it, brackets counted, strings not read. */
const enclosed = (code: string, open: number, pair: '()' | '{}'): string => {
  let depth = 0
  for (let at = open; at < code.length; at += 1) {
    if (code[at] === pair[0]) depth += 1
    else if (code[at] === pair[1] && --depth === 0) return code.slice(open, at + 1)
  }
  return code.slice(open)
}

/** The body of `function name(…) {…}` in `code`, or undefined when there is none. */
const bodyOf = (code: string, name: string): string | undefined => {
  const declared = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(code)
  if (declared === null) return undefined
  const open = code.indexOf('{', declared.index)
  return open === -1 ? undefined : enclosed(code, open, '{}')
}

/**
 * What the modules of `spawns` under `root` do that the third rule refuses.
 * Node's child_process uses `process.env` when `env` is omitted, so a second
 * call with no `env` would hand a child the token and the keys: the count is
 * what refuses it, and it counts every mention of a child_process function
 * outside its import. So the module takes those functions by their own
 * names — never the whole module, never under another name — and each
 * mention is a call that passes `env: <its function>()`; that function starts
 * from `spawnedEnvironment(`, and the module names `process.env` nowhere, so
 * it has no other environment to build one from.
 */
async function spawnOffences(
  root: string,
  spawns: Readonly<Record<string, { readonly calls: number; readonly env: string }>>,
): Promise<string[]> {
  const offending: string[] = []
  for (const [name, { calls, env }] of Object.entries(spawns)) {
    const file = path.join(root, name)
    const code = stripped(await readFile(file, 'utf8'))
    for (const { specifier, name: imported } of await diskNamesOf(file)) {
      if (/child_process$/.test(specifier) && imported === '*') {
        offending.push(`${name} takes the whole of ${specifier}`)
      }
    }
    for (const [, clause = '', specifier = ''] of code.matchAll(IMPORTS_CHILD_PROCESS)) {
      for (const part of /\{([^}]*)\}/.exec(clause)?.[1]?.split(',') ?? []) {
        const [imported, local] = part.trim().split(/\s+as\s+/)
        if (local !== undefined && imported !== undefined && !imported.startsWith('type ')) {
          offending.push(`${name} takes ${imported} from ${specifier} under another name`)
        }
      }
    }
    if (/\bprocess\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])/.test(code)) {
      offending.push(`${name} names process.env`)
    }
    const used = code.replace(IMPORTS_CHILD_PROCESS, '')
    const found = [...used.matchAll(NAMES_A_PROCESS)]
    if (found.length !== calls) {
      offending.push(`${name} starts a process in ${found.length} places; the rule states ${calls}`)
    }
    for (const mention of found) {
      const after = mention.index + mention[0].length
      const call = /^\s*\(/.exec(used.slice(after))
      if (call === null) {
        offending.push(`${name}: ${mention[0]} is named without being called`)
        continue
      }
      const given = enclosed(used, after + call[0].length - 1, '()')
      if (!new RegExp(`\\benv\\s*:\\s*${env}\\(\\)`).test(given)) {
        offending.push(`${name}: ${mention[0]}(…) is not given env: ${env}()`)
      }
    }
    if (env !== 'spawnedEnvironment' && !/\bspawnedEnvironment\s*\(/.test(bodyOf(code, env) ?? '')) {
      offending.push(`${name}: ${env} does not start from spawnedEnvironment`)
    }
  }
  return offending
}

describe('architecture', () => {
  it('core/ does not import agents/ or llm/', async () => {
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(({ specifier }) =>
      /(^|\/)(agents|llm)\//.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('core/ does not reach the network', async () => {
    const network = /^(node:)?(http|https|net|dgram|tls)$|^(undici|axios|node-fetch|got)$/
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(({ specifier }) =>
      network.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('agents/ does not import fs, git or child_process', async () => {
    // The guardrail is structural: there is no code path from an agent to the
    // disk, and this is what keeps it true once someone else contributes.
    const forbidden =
      /^(node:)?(fs|fs\/promises|child_process)$|^(simple-git|isomorphic-git|nodegit)$/
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'agents'))).filter(
      ({ specifier }) => forbidden.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('no module reachable from agents/ touches the disk or the network', async () => {
    const entries = await sourceFiles(path.join(SOURCE_ROOT, 'agents'))
    const closure = (await Promise.all(entries.map((file) => closureOf(file)))).flat()
    const offending = closure.filter(
      ({ specifier }) => DISK.test(specifier) || NETWORK.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('only src/llm/ imports the model SDK', async () => {
    // One crossing point (design 10). It is also why llm/client.ts holds types
    // only: agents/ imports it, and the closure above walks through it.
    const offending = (await importsUnder(SOURCE_ROOT)).filter(
      ({ file, specifier }) => MODEL_SDK.test(specifier) && !file.startsWith('llm/'),
    )
    expect(offending).toEqual([])
  })

  it('agents/ imports llm/client.js and nothing else from llm/', async () => {
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'agents'))).filter(
      ({ specifier }) => /(^|\/)llm\//.test(specifier) && !/llm\/client\.js$/.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('scaffold/ imports core/ and nothing else of ours', async () => {
    // It derives a layout and writes it. It has no business knowing about a
    // model, a graph, or the CLI that calls it.
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'scaffold'))).filter(
      ({ specifier }) => /(^|\/)(agents|llm|context|cli)\//.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('only two modules in scaffold/ touch the disk, and only one of them writes', async () => {
    // Two different interactions, and conflating them made this rule wrong on
    // its first run: templates.ts *reads* files shipped inside the package,
    // write.ts *writes* into someone else's repository. Only the second is the
    // seam stage 5's atomic applier replaces — one file is a refactor, five
    // would be a rewrite — but both have to be named, or the rule is a lie.
    const allowed = new Set(['scaffold/write.ts', 'scaffold/templates.ts'])
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'scaffold'))).filter(
      ({ file, specifier }) => DISK.test(specifier) && !allowed.has(file),
    )
    expect(offending).toEqual([])
  })

  it('nothing in scaffold/ but write.ts imports a writing function', async () => {
    // The distinction the rule above cannot make from a module specifier.
    const writers = /\b(writeFile|mkdir|rm|rename|appendFile|cp)\b/
    const sources = await sourceFiles(path.join(SOURCE_ROOT, 'scaffold'))
    const offending: string[] = []
    for (const source of sources) {
      const relative = path.relative(SOURCE_ROOT, source)
      if (relative === 'scaffold/write.ts') continue
      const body = await readFile(source, 'utf8')
      const imports = body.match(/^import \{[^}]*\} from '[^']*fs[^']*'/gm) ?? []
      if (imports.some((line) => writers.test(line))) offending.push(relative)
    }
    expect(offending).toEqual([])
  })

  it('only context/iac-fs and context/project-fs read a user repository', async () => {
    // Three readers, and the layer's whole disk surface. `project-fs` holds
    // every confinement rule for the application repository — the exclusion
    // list, the symlink refusal, the three caps — and a fourth module reading
    // that repository would be a second, unreviewed copy of them.
    const allowed = new Set([
      'context/iac-fs/snapshot.ts',
      'context/project-fs/snapshot.ts',
      'context/fixtures/index.ts',
    ])
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'context'))).filter(
      ({ file, specifier }) => DISK.test(specifier) && !allowed.has(file),
    )
    expect(offending).toEqual([])
  })

  it('only the named modules of cli/ touch the disk', async () => {
    // cli/ reads both repositories too — the plan a `--from` names, the
    // configuration in the application repository, whether a `--repo` is a
    // directory — so "only context/ reads a repository" was never the whole
    // truth. Each module is named, with what it touches.
    const allowed = new Set([
      'cli/commands/plan.ts', // reads the plan file `plan --from` names
      'cli/config.ts', // reads `.idp-agent.yml`
      'cli/personal.ts', // reads the personal configuration
      'cli/recording-fs.ts', // reads and writes a tape
      'cli/repository.ts', // stats and resolves a `--repo`
      'cli/source.ts', // stats a configured source
      'cli/trace-sink.ts', // writes a trace under IDP_TRACE_DIR
    ])
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'cli'))).filter(
      ({ file, specifier }) => DISK.test(specifier) && !allowed.has(file),
    )
    expect(offending).toEqual([])
  })

  it('only the named modules write, and only one starts a process', async () => {
    // Every module in src/, and so every closure: what stage 5 adds as a
    // writer has to be named here, with the functions it writes with. A
    // module taking the whole of fs, by a namespace, a default import or at
    // run time, can write with anything, so it counts as writing.
    const writes: Record<string, readonly string[]> = {
      'scaffold/write.ts': ['mkdir', 'writeFile'], // `init platform`'s scaffold
      'cli/recording-fs.ts': ['mkdir', 'writeFile'], // a tape, when recording
      'cli/trace-sink.ts': ['mkdir', 'writeFile'], // a trace, under IDP_TRACE_DIR
      // `open` is the one call that can do both; this one opens a file
      // O_RDONLY | O_NOFOLLOW, to read it.
      'context/project-fs/snapshot.ts': ['open'],
    }
    // `git ls-files`, and nothing else starts a process.
    const spawns = new Set(Object.keys(SPAWNS))
    const offending: string[] = []
    for (const file of await sourceFiles(SOURCE_ROOT)) {
      const name = path.relative(SOURCE_ROOT, file)
      for (const { specifier, name: imported } of await diskNamesOf(file)) {
        if (/child_process$/.test(specifier)) {
          if (!spawns.has(name)) offending.push(`${name} imports ${specifier}`)
        } else if (
          (imported === '*' || WRITING.test(imported)) &&
          !(writes[name] ?? []).includes(imported)
        ) {
          offending.push(`${name} imports ${imported} from ${specifier}`)
        }
      }
    }
    expect(offending).toEqual([])
  })

  it('core/ imports nothing from context/, cli/ or scaffold/', async () => {
    // core/ is the deterministic half: schemas, paths, serialisation, rules.
    // A dependency on a layer that reads a disk would make it one by proxy,
    // and its own README says it is not. Nothing enforced this until the
    // signer needed a symbol that had been parked in context/.
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(
      ({ specifier }) => /(^|\/)(context|cli|scaffold)\//.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('core/ neither reads nor writes', async () => {
    // core/README.md has said so since stage 2 and nothing checked it.
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(({ specifier }) =>
      DISK.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('core/ does not reach the model SDK', async () => {
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(({ specifier }) =>
      MODEL_SDK.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('trace/ reaches nothing but types, and only cli/ reaches it', async () => {
    // A trace is built from what the harness emits, and it leaves the process
    // through cli/, which owns every way out (ADR-0009). Outside its own
    // folder trace/ may name types and nothing else: `import type` is erased,
    // so no module it names is ever loaded, whichever layer or package that
    // is — a list of forbidden folders would pass the one nobody listed.
    // `fetch` needs no import, so trace/'s source is read for the name too —
    // the limit SECURITY.md states for the rules above.
    //
    // Not PATTERNS: this rule tells `import type` from an import of values,
    // and reads the source with its comments taken out. And a dynamic import
    // is refused whatever its argument, not only a literal.
    const statement =
      /^\s*(?:import|export)(\s+type)?\b[\w\s{},*$]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm
    const dynamic = /\b(?:import|require)\s*\(([^)]*)\)/g
    // `./../core` starts with `./` and leaves the folder all the same.
    const local = (specifier: string): boolean =>
      specifier.startsWith('./') && !specifier.split('/').includes('..')
    const offending: string[] = []
    for (const file of await sourceFiles(path.join(SOURCE_ROOT, 'trace'))) {
      const name = path.relative(SOURCE_ROOT, file)
      const code = stripped(await readFile(file, 'utf8'))
      for (const match of code.matchAll(statement)) {
        const typeOnly = match[1] !== undefined
        const specifier = match[2] ?? match[3] ?? ''
        if (
          DISK.test(specifier) ||
          NETWORK.test(specifier) ||
          MODEL_SDK.test(specifier) ||
          /(^|\/)cli\//.test(specifier)
        ) {
          offending.push(`${name} imports ${specifier}`)
        } else if (!typeOnly && !local(specifier)) {
          offending.push(`${name} imports values from ${specifier}`)
        }
      }
      for (const match of code.matchAll(dynamic)) {
        const argument = (match[1] ?? '').trim()
        const literal = /^(['"])([^'"]*)\1$/.exec(argument)
        if (literal?.[2] === undefined || !local(literal[2])) {
          offending.push(`${name} loads ${argument} at run time`)
        }
      }
      if (/\bfetch\b/.test(code)) offending.push(`${name} names fetch`)
    }
    for (const { file, specifier } of await importsUnder(SOURCE_ROOT)) {
      if (/(^|\/)trace\//.test(specifier) && !file.startsWith('cli/') && !file.startsWith('trace/')) {
        offending.push(`${file} imports ${specifier}`)
      }
    }
    expect(offending).toEqual([])
  })

  it('nothing in context/ names fetch or a global, and only the transport calls what it is handed', async () => {
    // The catalogue token leaves through one function, `catalogueTransport`'s
    // request, over the `fetch` cli/ hands it (docs/backstage-http-brief.md
    // § 4). A second road out of context/ would be a second place to send it.
    expect(await fetchOffences(SOURCE_ROOT)).toEqual([])
  })

  it('nothing reachable from agents/ is in context/backstage/, names fetch or names a global', async () => {
    expect(await agentsReachOffences(SOURCE_ROOT)).toEqual([])
  })

  it('every process src/ starts is given spawnedEnvironment', async () => {
    // A child is handed the environment it starts with, and `git` runs in
    // every inspected repository: without the Backstage token and without any
    // provider key (`context/spawned-environment.ts`).
    expect(await spawnOffences(SOURCE_ROOT, SPAWNS)).toEqual([])
  })
})

describe('the architecture rules themselves', () => {
  // Every rule above is a filter over what the helpers read, and an empty read
  // passes every filter: a renamed folder, a file the walk skips or an import
  // that resolves nowhere used to leave the rules green over nothing.

  /** A scratch source tree holding `files`, by path relative to its root. */
  const tree = async (files: Record<string, string>): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'idp-architecture-'))
    for (const [relative, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
      await writeFile(path.join(root, relative), text, 'utf8')
    }
    return root
  }

  it('fails on a folder that is not there, rather than reading it as empty', async () => {
    await expect(sourceFiles(path.join(SOURCE_ROOT, 'no-such-layer'))).rejects.toThrow()
    await expect(importsOf(path.join(SOURCE_ROOT, 'no-such-file.ts'))).rejects.toThrow()
  })

  it('reads every layer it has a rule about, and the tree as a whole', async () => {
    for (const layer of ['agents', 'cli', 'context', 'core', 'llm', 'scaffold', 'trace']) {
      expect((await sourceFiles(path.join(SOURCE_ROOT, layer))).length, layer).toBeGreaterThan(0)
    }
    expect((await sourceFiles(SOURCE_ROOT)).length).toBeGreaterThan(40)
  })

  it('reads .mts and .cts sources, not only .ts', async () => {
    const root = await tree({ 'a.ts': '', 'b.mts': '', 'c.cts': '', 'd.md': '' })
    const names = (await sourceFiles(root)).map((file) => path.basename(file)).sort()
    expect(names).toEqual(['a.ts', 'b.mts', 'c.cts'])
  })

  it('fails on a relative import that resolves to no file', async () => {
    const root = await tree({
      'entry.ts': "import { gone } from './gone.js'\n",
      'module.mts': "import { here } from './here.mjs'\n",
      'here.mts': "import { readFile } from 'node:fs/promises'\n",
    })
    await expect(closureOf(path.join(root, 'entry.ts'))).rejects.toThrow(/gone\.js/)
    // `.mjs` names the `.mts` it compiles from, as `.js` names a `.ts`.
    const closure = await closureOf(path.join(root, 'module.mts'))
    expect(closure.map(({ specifier }) => specifier)).toEqual(['./here.mjs', 'node:fs/promises'])
  })

  it('every relative import in src/ resolves to a file', async () => {
    const unresolved: string[] = []
    for (const { file, specifier } of await importsUnder(SOURCE_ROOT)) {
      if (!specifier.startsWith('.')) continue
      await resolved(path.join(SOURCE_ROOT, file), specifier).catch((error: unknown) => {
        unresolved.push(String(error))
      })
    }
    expect(unresolved).toEqual([])
  })

  it('reads what a module takes from fs and child_process, whatever the import form', async () => {
    const root = await tree({
      'named.ts': "import { readFile, writeFile as put } from 'node:fs/promises'\n",
      'types.ts': "import type { Dirent } from 'node:fs'\nimport { type Stats, stat } from 'fs'\n",
      'whole.ts': "import * as fs from 'node:fs'\nimport disk from 'fs/promises'\n",
      'passed.ts': "export { rm } from 'node:fs/promises'\nexport * from 'node:child_process'\n",
      'late.ts': "const cp = await import('node:child_process')\nrequire('fs')\n",
      // The whole writing API under a name WRITING does not list.
      'aliased.ts':
        "import { promises as fsp } from 'node:fs'\nimport { default as whole } from 'node:fs/promises'\n",
      // A require made at run time loads fs with no specifier to read.
      'loader.ts': "import { createRequire } from 'node:module'\nimport { Worker } from 'worker_threads'\n",
      // A statement with no quote before an import is not the import's clause.
      'after.ts': "export type Shape = { a: number }\nimport { writeFile } from 'node:fs'\n",
    })
    const names = async (file: string): Promise<string[]> =>
      (await diskNamesOf(path.join(root, file))).map(({ specifier, name }) => `${specifier} ${name}`)
    expect(await names('named.ts')).toEqual(['node:fs/promises readFile', 'node:fs/promises writeFile'])
    expect(await names('types.ts')).toEqual(['fs stat'])
    expect(await names('whole.ts')).toEqual(['node:fs *', 'fs/promises *'])
    expect(await names('passed.ts')).toEqual(['node:fs/promises rm', 'node:child_process *'])
    expect(await names('late.ts')).toEqual(['node:child_process *', 'fs *'])
    expect(await names('aliased.ts')).toEqual(['node:fs *', 'node:fs/promises *'])
    expect(await names('loader.ts')).toEqual(['node:module *', 'worker_threads *'])
    expect(await names('after.ts')).toEqual(['node:fs writeFile'])
  })

  it('refuses every way context/ can name fetch or a global, and only those', async () => {
    const root = await tree({
      'context/call.ts': "await fetch('x')\n",
      'context/kept.ts': 'const f = fetch\nf(url)\n',
      'context/this.ts': 'globalThis.fetch(url)\n',
      'context/node.ts': 'global.fetch(url)\n',
      'context/type.ts': 'type F = typeof globalThis.fetch\n',
      'context/socket.ts': 'new WebSocket(url)\nnew XMLHttpRequest()\n',
      // Text inside a regular expression: `secrets.ts`'s pattern.
      'context/pattern.ts': 'const reads = /ENV\\.fetch\\(/\n',
      'context/said.ts': '// fetch(url) through globalThis\n/* global.fetch */\nexport const x = 1\n',
      'context/other.ts': 'deps.catalogueFetch(url)\n',
      'context/backstage/transport.ts': 'await options.catalogueFetch(url, init)\n',
      // What looks like a comment inside a string, a template or a regular
      // expression hides nothing after it.
      'context/address.ts': "const u = 'https://evil.example'; await fetch(u)\n",
      'context/accept.ts': "const h = { accept: '*/*' }\nawait fetch(u)\n/** doc */\n",
      'context/template.ts': "const t = `${'//'}/*`; await fetch(u)\n",
      'context/slashes.ts': 'const r = /\\/\\//; await fetch(u)\n',
      // A quote in a comment opens no string.
      'context/quoted.ts': "// don't\nawait fetch(u)\n",
      // A road out by import rather than by a global.
      'context/raw.ts': "import https from 'node:https'\n",
      'context/late.ts': "const net = await import('node:net')\nconst w = require('undici')\n",
      'context/named.ts': 'const m = await import(name)\n',
    })
    expect((await fetchOffences(root)).sort()).toEqual(
      [
        'context/address.ts names fetch',
        'context/accept.ts names fetch',
        'context/template.ts names fetch',
        'context/slashes.ts names fetch',
        'context/quoted.ts names fetch',
        'context/raw.ts imports node:https',
        'context/late.ts imports node:net',
        'context/late.ts imports undici',
        'context/named.ts loads name at run time',
        'context/call.ts names fetch',
        'context/kept.ts names fetch',
        'context/this.ts names a global way out',
        'context/this.ts names fetch',
        'context/node.ts names a global way out',
        'context/node.ts names fetch',
        'context/type.ts names a global way out',
        'context/type.ts names fetch',
        'context/socket.ts names a global way out',
        'context/other.ts calls a catalogueFetch',
      ].sort(),
    )

    // The transport calls what it is handed as `options.catalogueFetch(`, and
    // no other way: a destructured one is a second name to call it by.
    const destructured = await tree({
      'context/backstage/transport.ts': 'const { catalogueFetch } = options\nawait catalogueFetch(url, init)\n',
    })
    expect(await fetchOffences(destructured)).toEqual(['context/backstage/transport.ts calls a catalogueFetch'])
  })

  it('refuses what agents/ reaches in context/backstage/, or that names fetch or a global', async () => {
    const root = await tree({
      'agents/reader.ts': "import { x } from './helper.js'\n",
      'agents/helper.ts': "export const x = 1\nexport const y = await fetch('x')\n",
      'agents/typed.ts': "import type { CatalogueTransport } from '../context/backstage/transport.js'\n",
      'agents/wide.ts': 'export const z = globalThis\n',
      'context/backstage/transport.ts': 'export interface CatalogueTransport {}\n',
    })
    expect((await agentsReachOffences(root)).sort()).toEqual(
      [
        // A type import counts: the walk reads every specifier, erased or not.
        'agents/ reaches ../context/backstage/transport.js',
        'agents/helper.ts names fetch',
        'agents/wide.ts names a global way out',
      ].sort(),
    )
    const clean = await tree({ 'agents/a.ts': "import { b } from './b.js'\n", 'agents/b.ts': 'export const b = 1\n' })
    expect(await agentsReachOffences(clean)).toEqual([])
  })

  it('refuses a process started without spawnedEnvironment', async () => {
    const spawns = { 'spawns.ts': { calls: 1, env: 'gitEnvironment' } }
    const good = [
      "import { execFile } from 'node:child_process'",
      "import { spawnedEnvironment } from './spawned-environment.js'",
      'function gitEnvironment(): NodeJS.ProcessEnv {',
      '  return { ...spawnedEnvironment(), LC_ALL: "C" }',
      '}',
      "const git = () => execFile('git', ['status'], { env: gitEnvironment() }, (error) => {})",
      "const matched = /x/.exec('x')",
      '',
    ].join('\n')
    expect(await spawnOffences(await tree({ 'spawns.ts': good }), spawns)).toEqual([])

    const second = `${good}execFile('git', ['log'], { cwd: '/' })\n`
    expect(await spawnOffences(await tree({ 'spawns.ts': second }), spawns)).toEqual([
      'spawns.ts starts a process in 2 places; the rule states 1',
      'spawns.ts: execFile(…) is not given env: gitEnvironment()',
    ])

    const inherited = good.replace('...spawnedEnvironment()', '...process.env')
    expect(await spawnOffences(await tree({ 'spawns.ts': inherited }), spawns)).toEqual([
      'spawns.ts names process.env',
      'spawns.ts: gitEnvironment does not start from spawnedEnvironment',
    ])

    const other = good.replace('{ env: gitEnvironment() }', "{ env: { PATH: '/bin' } }")
    expect(await spawnOffences(await tree({ 'spawns.ts': other }), spawns)).toEqual([
      'spawns.ts: execFile(…) is not given env: gitEnvironment()',
    ])

    // A function of child_process by any other road: a namespace, an alias,
    // a value passed on, a module loaded at run time. Each would start a
    // process the count and the `env` check never see.
    const namespace = `${good.replace("import { execFile }", 'import * as cp')}cp.execFile('sh', ['-c', 'env'])\n`
    expect(await spawnOffences(await tree({ 'spawns.ts': namespace }), spawns)).toEqual([
      'spawns.ts takes the whole of node:child_process',
      'spawns.ts starts a process in 2 places; the rule states 1',
      'spawns.ts: execFile(…) is not given env: gitEnvironment()',
    ])
    const aliased = `${good.replace('{ execFile }', '{ execFile, spawn as go }')}go('sh')\n`
    expect(await spawnOffences(await tree({ 'spawns.ts': aliased }), spawns)).toEqual([
      'spawns.ts takes spawn from node:child_process under another name',
    ])
    const promised = `${good}const run = promisify(execFile)\nawait run('sh')\n`
    expect(await spawnOffences(await tree({ 'spawns.ts': promised }), spawns)).toEqual([
      'spawns.ts starts a process in 2 places; the rule states 1',
      'spawns.ts: execFile is named without being called',
    ])
    const loaded = `${good}const cp = await import('node:child_process')\n`
    expect(await spawnOffences(await tree({ 'spawns.ts': loaded }), spawns)).toEqual([
      'spawns.ts takes the whole of node:child_process',
    ])
  })
})
