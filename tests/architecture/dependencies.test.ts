import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOOR_WORDS } from '../support/fake-gh.js'

const SOURCE_ROOT = path.resolve(import.meta.dirname, '../../src')
/** tests/ itself: the door rule reads it too. */
const TESTS_ROOT = path.resolve(import.meta.dirname, '..')

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
 * child_process function it makes and the functions one of whose results each
 * call is given as `env`. They are the only modules the rule on writers lets
 * import child_process, so a module added there is stated here too.
 */
type Spawns = Readonly<Record<string, { readonly calls: number; readonly env: readonly string[] }>>
const SPAWNS: Spawns = {
  // `gitIn` for every read and write, `pushIn` for the one push form (stage 6 brief § 4).
  'process/git.ts': { calls: 2, env: ['gitEnvironment', 'pushEnvironment'] },
  // `spawnGh`, which every gh call goes through.
  'process/gh.ts': { calls: 1, env: ['ghEnvironment'] },
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
const enclosed = (code: string, open: number, pair: '()' | '{}' | '[]'): string => {
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
  // After the parameters: a destructured one opens a brace of its own.
  const parameters = declared.index + declared[0].length - 1
  const open = code.indexOf('{', parameters + enclosed(code, parameters, '()').length)
  return open === -1 ? undefined : enclosed(code, open, '{}')
}

/**
 * The names `function name(…)` in `code` declares for its parameters, and
 * whether one of them is destructured — whose names a rule cannot follow, so
 * a check over them can only refuse.
 */
const parametersOf = (code: string, name: string): { names: string[]; destructured: boolean } => {
  const declared = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(code)
  if (declared === null) return { names: [], destructured: false }
  const list = enclosed(code, declared.index + declared[0].length - 1, '()').slice(1, -1)
  return {
    names: [...list.matchAll(/(?:^|,)\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?=[?:=,]|$)/g)].map((match) => match[1] ?? ''),
    destructured: /(?:^|,)\s*(?:\.\.\.)?[{[]/.test(list),
  }
}

/** `code` with the arguments of every call of `callee` taken out: `callee()`, whatever it was given. */
const argumentsDropped = (code: string, callee: string): string => {
  let kept = ''
  let rest = code
  for (let call = new RegExp(`\\b${callee}\\s*\\(`).exec(rest); call !== null; ) {
    const open = call.index + call[0].length - 1
    kept += `${rest.slice(0, open)}()`
    rest = rest.slice(open + enclosed(rest, open, '()').length)
    call = new RegExp(`\\b${callee}\\s*\\(`).exec(rest)
  }
  return kept + rest
}

/**
 * What the modules of `spawns` under `root` do that the third rule refuses.
 * Node's child_process uses `process.env` when `env` is omitted, so a second
 * call with no `env` would hand a child the token and the keys: the count is
 * what refuses it, and it counts every mention of a child_process function
 * outside its import. So the module takes those functions by their own
 * names — never the whole module, never under another name — and each
 * mention is a call that passes `env: <one of its functions>(…)`; each of
 * them starts from `spawnedEnvironment(`, and the module names `process.env`
 * nowhere, so it has no other environment to build one from. A function may
 * be handed one — a test's — and it still goes through `spawnedEnvironment`.
 */
async function spawnOffences(root: string, spawns: Spawns): Promise<string[]> {
  const offending: string[] = []
  for (const [name, { calls, env: functions }] of Object.entries(spawns)) {
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
      if (!functions.some((env) => new RegExp(`\\benv\\s*:\\s*${env}\\(`).test(given))) {
        const named = functions.map((env) => `${env}()`).join(' or ')
        offending.push(`${name}: ${mention[0]}(…) is not given env: ${named}`)
      }
    }
    for (const env of functions) {
      if (env !== 'spawnedEnvironment' && !/\bspawnedEnvironment\s*\(/.test(bodyOf(code, env) ?? '')) {
        offending.push(`${name}: ${env} does not start from spawnedEnvironment`)
      }
      if (env !== 'spawnedEnvironment') {
        // Handed an environment, the function has a raw one of its own: it may
        // name it only inside `spawnedEnvironment(…)`, or `return { ...env }`
        // after a call whose result is dropped would pass every line above. A
        // property of the same name (`options.env`) is not the parameter; a
        // spread of it is.
        const outside = argumentsDropped(bodyOf(code, env) ?? '', 'spawnedEnvironment')
        const { names, destructured } = parametersOf(code, env)
        if (destructured) offending.push(`${name}: ${env} destructures a parameter, which no rule can follow`)
        for (const parameter of [...names, 'arguments']) {
          if (new RegExp(`(?<![\\w$])(?<![^.]\\.)${parameter.replace(/\$/g, '\\$')}\\b`).test(outside)) {
            offending.push(`${name}: ${env} names ${parameter} outside spawnedEnvironment(…)`)
          }
        }
      }
    }
  }
  return offending
}

/**
 * An import statement, with whether it is `import type`. The clause holds no
 * `=` and no quote, so it never runs on into the statement after it: an
 * `export type X = {…}` read as the clause of the import below it made that
 * import look erased.
 */
const STATEMENT =
  /^\s*(?:import|export)(\s+type)?\b[\w\s{},*$]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm

/** A module loaded at run time: `import(…)` or `require(…)`, whatever the argument. */
const LOADED = /\b(?:import|require)\s*\(([^)]*)\)/g

/** What a module loads, one statement or call at a time. */
interface Load {
  /** The specifier, or undefined for a run-time load whose argument is not a literal. */
  readonly specifier: string | undefined
  /** How a message names it: the specifier, or the load as written. */
  readonly written: string
  /** `import type` or `export type`: erased, so nothing is loaded. */
  readonly typeOnly: boolean
  /** An `export … from`: what is loaded is handed on to every importer. */
  readonly handedOn: boolean
}

const loads = new Map<string, Promise<Load[]>>()

/**
 * Everything `file` loads, read with its comments taken out: static imports
 * and re-exports, told apart from `import type`, side-effect imports, and
 * `import(…)`/`require(…)` whatever their argument. Every load at run time
 * counts as one of values, a type written as `import('…')` included: a rule
 * cannot tell that position from a value's, and `import type` says the same.
 */
function loadsOf(file: string): Promise<Load[]> {
  const cached = loads.get(file)
  if (cached !== undefined) return cached
  const read = (async (): Promise<Load[]> => {
    const code = stripped(await readFile(file, 'utf8'))
    const found: Load[] = []
    for (const match of code.matchAll(STATEMENT)) {
      const specifier = match[2] ?? match[3] ?? ''
      const handedOn = /^\s*export\b/.test(match[0])
      found.push({ specifier, written: specifier, typeOnly: match[1] !== undefined, handedOn })
    }
    for (const match of code.matchAll(LOADED)) {
      const argument = (match[1] ?? '').trim()
      const literal = /^(['"])([^'"]*)\1$/.exec(argument)?.[2]
      const written = literal === undefined ? argument : `${argument} at run time`
      found.push({ specifier: literal, written, typeOnly: false, handedOn: false })
    }
    return found
  })()
  loads.set(file, read)
  return read
}

/** The message for a load no rule can follow, whichever rule refuses it. */
const unfollowable = (name: string, load: Load): string =>
  `${name} loads ${load.written} at run time: no rule can tell what it names`

/** The name under `root` of the module a relative specifier in `file` names, `.ts` for `.js`. */
const targetOf = (root: string, file: string, specifier: string): string =>
  nameUnder(root, path.resolve(path.dirname(file), specifier.replace(/\.([mc]?)js$/, '.$1ts')))

/**
 * What the fourth forge rule refuses under `root`: a module outside cli/ and
 * forge/ that loads anything of forge/ — an import of values, a side-effect
 * import, a module loaded at run time — however many hops away, and a
 * run-time load no source can spell. The walk follows what a module loads
 * into cli/ too: a context/ module importing a cli/ module that imports the
 * forge passed this rule while it read direct imports only. `import type` is
 * erased, so naming a forge's shapes is allowed, as agents/ names
 * `llm/client.ts`'s, and a type imported from cli/ loads nothing either. A
 * specifier is resolved, not matched: a folder called `forge` elsewhere is not
 * the layer.
 */
async function forgeReachOffences(root: string): Promise<string[]> {
  const offending: string[] = []
  for (const file of await sourceFiles(root)) {
    const name = nameUnder(root, file)
    if (name.startsWith('cli/') || name.startsWith('forge/')) continue
    const seen = new Set<string>([file])
    const walk = async (from: string, trail: string): Promise<void> => {
      for (const load of await loadsOf(from)) {
        if (load.specifier === undefined) {
          if (from === file) offending.push(unfollowable(name, load))
          continue
        }
        if (load.typeOnly || !load.specifier.startsWith('.')) continue
        const step = `${trail} → ${load.written}`
        if (targetOf(root, from, load.specifier).startsWith('forge/')) {
          offending.push(step)
          continue
        }
        const next = await resolved(from, load.specifier)
        if (seen.has(next)) continue
        seen.add(next)
        await walk(next, step)
      }
    }
    await walk(file, name)
  }
  return offending
}

/** Built-ins forge/ may import: neither reads, writes, nor opens a socket. */
const FORGE_BUILT_INS = new Set(['node:crypto', 'node:path'])

/**
 * What the forge's own imports rule refuses under `root`: anything a module of
 * forge/ loads that is not core/, process/, forge/ itself or one of
 * `FORGE_BUILT_INS` — a type included, since the list is short enough to keep
 * whole. A list of what may be imported, not of what may not: `node:http`
 * and `node:fs/promises` passed every rule while this one refused packages
 * only, and a forge that opened its own socket or read a file would be a
 * second way out no other rule sees.
 */
async function forgeImportOffences(root: string): Promise<string[]> {
  const offending: string[] = []
  for (const file of await sourceFiles(path.join(root, 'forge'))) {
    const name = nameUnder(root, file)
    for (const load of await loadsOf(file)) {
      if (load.specifier === undefined) {
        offending.push(unfollowable(name, load))
      } else if (!load.specifier.startsWith('.')) {
        if (!FORGE_BUILT_INS.has(load.specifier)) offending.push(`${name} imports ${load.specifier}`)
      } else if (!/^(core|process|forge)\//.test(targetOf(root, file, load.specifier))) {
        offending.push(`${name} imports ${load.specifier}`)
      }
    }
  }
  return offending
}

/** The one launcher, and the modules that may load it. */
const LAUNCHER = 'process/git.ts'
const RUNS_GIT = (name: string): boolean => name === 'context/project-fs/snapshot.ts' || name.startsWith('forge/')

/**
 * What a rule about one module refuses under `root`: a module other than
 * those `may` names that loads `target`, a run-time load no source can spell
 * from one of those others, and one of the named handing `target` on with an
 * `export … from`. A type is erased and may be named anywhere.
 */
async function loaderOffences(
  root: string,
  target: string,
  may: (name: string) => boolean,
): Promise<string[]> {
  const offending: string[] = []
  for (const file of await sourceFiles(root)) {
    const name = nameUnder(root, file)
    if (name === target) continue
    for (const load of await loadsOf(file)) {
      if (load.specifier === undefined) {
        if (!may(name)) offending.push(unfollowable(name, load))
        continue
      }
      if (load.typeOnly || !load.specifier.startsWith('.')) continue
      if (targetOf(root, file, load.specifier) !== target) continue
      if (!may(name)) offending.push(`${name} → ${load.written}`)
      else if (load.handedOn) offending.push(`${name} hands on ${load.written}`)
    }
  }
  return offending
}

/**
 * What the launcher's rule refuses under `root`: a module that loads
 * `process/git.ts` other than project-fs's snapshot and forge/, a run-time
 * load no source can spell, and one of those two handing the launcher on with
 * an `export … from`. `gitIn(repo)(['show', 'HEAD:.env'])` reads any tracked
 * file, so a module of context/ or llm/ loading it would go around every
 * confinement project-fs holds — the secret exclusions first. A type is
 * erased and may be named anywhere; `process/environment.ts` starts nothing.
 */
const launcherOffences = (root: string): Promise<string[]> => loaderOffences(root, LAUNCHER, RUNS_GIT)

/** The confinement primitive, and the modules that may load it. */
const CONFINE = 'confine/confine.ts'
const CONFINES = new Set([
  'scaffold/write.ts', // `init platform`'s writer
  'context/iac-fs/snapshot.ts', // the declarations repository
  'context/project-fs/snapshot.ts', // the application repository
  'context/backstage/cache.ts', // the catalogue kept under the person's cache folder, never a repository
])

/**
 * What the confinement rule refuses under `root`: a module other than the
 * four that act on a user's disk through it loading `confine/confine.ts`, and
 * one of them handing it on. `createNew` writes and `openToRead` reads with no
 * fs function in the importer's source, so a fifth module loading it would be
 * a writer the rule naming writers never sees, and a reader the rule naming
 * readers never sees.
 */
const confineOffences = (root: string): Promise<string[]> =>
  loaderOffences(root, CONFINE, (name) => CONFINES.has(name))

/** The catalogue cache, and the one module that may load it. */
const CACHE = 'context/backstage/cache.ts'
const READS_CACHE = (name: string): boolean => name === 'context/backstage/provider.ts'

/**
 * What the cache's rule refuses under `root`: a module other than the
 * provider loading `context/backstage/cache.ts`, a run-time load no source can
 * spell, and the provider handing the store on. The provider is the module
 * whose loop runs the pre-pass and `readValue` on every item, so the one
 * module that may take a `Served` from a file on disk is the one that reads
 * it as a page: a copy is never a source that skips the reader.
 */
const cacheOffences = (root: string): Promise<string[]> => loaderOffences(root, CACHE, READS_CACHE)

/** A word's own boundaries: `--force` is not `--force-with-lease=`, `--tags` is not `--no-follow-tags`. */
const doorPattern = (word: string): RegExp => {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const before = /^[\w-]/.test(word) ? '(?<![\\w-])' : ''
  const after = /[\w-]$/.test(word) ? '(?![\\w-])' : ''
  return new RegExp(`${before}${escaped}${after}`)
}

/**
 * What a door rule refuses under `root`: a source file `allowed` does not name
 * whose code, comments stripped, holds one of § 6's door strings as a word
 * (stage 6 brief). Textual, as the fetch rules are: a door split across two
 * strings passes, and the launcher's grammar refuses it at run time.
 */
async function doorOffences(root: string, allowed: (name: string) => boolean): Promise<string[]> {
  const offending: string[] = []
  for (const file of await sourceFiles(root)) {
    const name = nameUnder(root, file)
    if (allowed(name)) continue
    const code = stripped(await readFile(file, 'utf8'))
    for (const word of DOOR_WORDS) if (doorPattern(word).test(code)) offending.push(`${name} names ${word}`)
  }
  return offending
}

/** Any name of a GitHub token: `GH_TOKEN`, `GITHUB_TOKEN`, and every `GH_…TOKEN` or `GITHUB_…TOKEN`. */
const TOKEN_NAME = /(?<![\w$])(?:GH|GITHUB)_\w*TOKEN(?![\w$])/g

/** The gh launcher, and the one list in it that may name the Enterprise tokens: to remove them. */
const GH_LAUNCHER = 'process/gh.ts'
const ENTERPRISE_TOKENS = new Set(['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])

/**
 * What the credential rule refuses under `root`: a source naming a GitHub
 * token's variable at all — `GH_TOKEN`, `GITHUB_TOKEN`, any `GH_…TOKEN` or
 * `GITHUB_…TOKEN`, however it would read it: a property, an index, a
 * destructuring, `Reflect.get`, a comparison — or `hosts.yml`, gh's stored
 * login. The one exception is `process/gh.ts`'s `GH_REMOVED`, which may name
 * the two Enterprise tokens, and only them: it drops them by upper-cased
 * comparison and never reads a value (§ 5). Comments are stripped, so a
 * comment may say what gh reads.
 */
async function credentialOffences(root: string): Promise<string[]> {
  const offending: string[] = []
  for (const file of await sourceFiles(root)) {
    const name = nameUnder(root, file)
    let code = stripped(await readFile(file, 'utf8'))
    if (name === GH_LAUNCHER) {
      const declared = /\bGH_REMOVED\b[^=]*=\s*\[/.exec(code)
      if (declared !== null) {
        const open = declared.index + declared[0].length - 1
        const list = enclosed(code, open, '[]')
        for (const [token] of list.matchAll(TOKEN_NAME)) {
          if (!ENTERPRISE_TOKENS.has(token)) offending.push(`${name} names ${token}`)
        }
        code = code.slice(0, open) + code.slice(open + list.length)
      }
    }
    for (const [token] of code.matchAll(TOKEN_NAME)) offending.push(`${name} names ${token}`)
    if (/hosts\.yml/.test(code)) offending.push(`${name} names hosts.yml`)
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

  it('scaffold/ imports core/ and confine/, and nothing else of ours', async () => {
    // It derives a layout and writes it. It has no business knowing about a
    // model, a graph, or the CLI that calls it. A list of what may be imported,
    // resolved, not a list of folders it may not: `forge/`, `process/` and
    // `trace/` passed the list of four it replaced. confine/ is the leaf that
    // confines a path on the disk, which core/ cannot.
    const offending: string[] = []
    for (const file of await sourceFiles(path.join(SOURCE_ROOT, 'scaffold'))) {
      for (const { specifier } of await importsOf(file)) {
        if (!specifier.startsWith('.')) continue
        if (!/^(core|confine|scaffold)\//.test(targetOf(SOURCE_ROOT, file, specifier))) {
          offending.push(`${nameUnder(SOURCE_ROOT, file)} imports ${specifier}`)
        }
      }
    }
    expect(offending).toEqual([])
  })

  it('only two modules in scaffold/ touch the disk, and only one of them writes', async () => {
    // Two different interactions, and conflating them made this rule wrong on
    // its first run: templates.ts *reads* files shipped inside the package,
    // write.ts *writes* into someone else's repository. Only the second is a
    // writer — it stays the writer for a repository being created; a branch in
    // an existing one is forge/local/'s (ADR-0010) — but both have to be
    // named, or the rule is a lie.
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

  it('in context/, only iac-fs, project-fs, the fixtures and the catalogue cache touch the disk', async () => {
    // Four modules, and the layer's whole disk surface. `project-fs` holds
    // every confinement rule for the application repository — the exclusion
    // list, the symlink refusal, the three caps — and another module reading
    // that repository would be a second, unreviewed copy of them. The cache
    // reads and writes under the person's cache folder, never a repository.
    const allowed = new Set([
      'context/iac-fs/snapshot.ts',
      'context/project-fs/snapshot.ts',
      'context/fixtures/index.ts',
      'context/backstage/cache.ts', // the catalogue kept under the person's cache folder, never a repository
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

  it('only the named modules write, and only process/git.ts and process/gh.ts start a process', async () => {
    // Every module in src/, and so every closure: what stage 5 adds as a
    // writer has to be named here, with the functions it writes with. A
    // module taking the whole of fs, by a namespace, a default import or at
    // run time, can write with anything, so it counts as writing. The forge
    // is in neither list: it writes into a repository through git — objects
    // and one ref — never through a writing function of its own.
    const writes: Record<string, readonly string[]> = {
      'scaffold/write.ts': ['mkdir'], // the directory `init platform` was named
      'cli/recording-fs.ts': ['mkdir', 'writeFile'], // a tape, when recording
      'cli/trace-sink.ts': ['mkdir', 'writeFile'], // a trace, under IDP_TRACE_DIR
      // `open` is the one call that can do both: the confinement primitive
      // opens a file O_RDONLY | O_NOFOLLOW for iac-fs and project-fs, and
      // O_CREAT | O_EXCL | O_NOFOLLOW for `init platform`, whose folders it
      // makes one at a time. Only the four named below may load it.
      'confine/confine.ts': ['mkdir', 'open'],
      // Folders and new files through confine/; a copy or a secret renamed
      // into place, a pruned copy unlinked and its empty folder removed.
      'context/backstage/cache.ts': ['rename', 'unlink', 'rmdir'],
    }
    // `process/git.ts`, for the Inspector's `git ls-files`, the forge and the
    // push, and `process/gh.ts`, for gh (stage 6 brief § 6): nothing else
    // starts a process.
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

  it('core/ imports nothing from context/, cli/, scaffold/, forge/, process/ or confine/', async () => {
    // core/ is the deterministic half: schemas, paths, serialisation, rules.
    // A dependency on a layer that reads a disk would make it one by proxy,
    // and its own README says it is not. Nothing enforced this until the
    // signer needed a symbol that had been parked in context/. forge/
    // depends on core/ — `Cleared` is core's — so core naming forge, even by
    // type, is a cycle; and at run time it is core reaching a process.
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(
      ({ specifier }) => /(^|\/)(context|cli|scaffold|forge|process|confine)\//.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('core/ neither reads nor writes, however many hops away', async () => {
    // core/README.md has said so since stage 2 and nothing checked it; then
    // only direct imports were checked, until stage 5 measured it: core/
    // importing a module that imports child_process passed every rule.
    const entries = await sourceFiles(path.join(SOURCE_ROOT, 'core'))
    const reached = new Set<string>()
    const closure: Import[] = []
    for (const entry of entries) closure.push(...(await closureOf(entry, reached)))
    const offending = closure.filter(({ specifier }) => DISK.test(specifier))
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
    // provider key (`process/environment.ts`).
    expect(await spawnOffences(SOURCE_ROOT, SPAWNS)).toEqual([])
  })

  it('process/ imports nothing of ours, and only node: built-ins', async () => {
    // A leaf both context/project-fs and forge/ import: the one place a
    // process is started, with the one environment a child is given. Anything
    // it imported would be reachable from both.
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'process'))).filter(
      ({ specifier }) => !specifier.startsWith('node:') && !/^\.\/[\w-]+\.js$/.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('confine/ imports nothing of ours, and only node: built-ins', async () => {
    // A leaf scaffold/, context/iac-fs and context/project-fs import: the one
    // lstat, realpath and O_NOFOLLOW primitive a user's repository is read and
    // written through. Anything it imported would be reachable from all three,
    // and scaffold/ may reach core/ and it alone.
    const offending = (await importsUnder(path.join(SOURCE_ROOT, 'confine'))).filter(
      ({ specifier }) => !specifier.startsWith('node:') && !/^\.\/[\w-]+\.js$/.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('only scaffold/write.ts, context/iac-fs, context/project-fs and context/backstage/cache.ts load confine/', async () => {
    expect(await confineOffences(SOURCE_ROOT)).toEqual([])
  })

  it('only context/backstage/provider.ts loads context/backstage/cache.ts', async () => {
    // A catalogue kept on disk is an input: the provider's loop runs the
    // pre-pass and the reader on every item of a copy, as on a page. Another
    // module taking a `Served` from the store would answer from a file that
    // skipped them (docs/plans/backstage-http-slice-2.md, Task 2.2).
    expect(await cacheOffences(SOURCE_ROOT)).toEqual([])
  })

  it('forge/ imports core/, process/, node:crypto and node:path, and nothing else', async () => {
    // A forge is the one layer that writes into a user's repository. What it
    // may reach is kept as small as scaffold/'s — and smaller: no package at
    // all, because a git client the DISK list does not name (`execa`, `zx`,
    // `dugite`) passed every rule when it was measured, and two built-ins,
    // because `node:http` and `node:fs/promises` passed too while only
    // packages were refused. A relative import is resolved, so a layer added
    // later is refused without being listed.
    expect(await forgeImportOffences(SOURCE_ROOT)).toEqual([])
  })

  it('only context/project-fs and forge/ load the git launcher', async () => {
    // `gitIn` runs any git command in any repository it is handed, and
    // `show HEAD:.env` reads a secret project-fs would never return. The two
    // modules that may load it are the ones that hold its confinements: the
    // Inspector's listing, and the forge's create-only plumbing (ADR-0010).
    // Measured: context/backstage/ and llm/ loading it passed every rule.
    expect(await launcherOffences(SOURCE_ROOT)).toEqual([])
  })

  it('only cli/ reaches forge/ at runtime', async () => {
    // `import type` names the interface without being able to call it — the
    // shape `llm/client.ts` has for agents/. Anything else, from anywhere but
    // cli/, is a writer reachable from a layer that was never meant to write:
    // core/ and context/ importing a forge passed every rule at eee67d6.
    expect(await forgeReachOffences(SOURCE_ROOT)).toEqual([])
  })

  it('nothing in src/ names a door the allow-list refuses', async () => {
    // The launchers refuse every vector outside § 6's grammar at run time;
    // this keeps the source from holding the words at all.
    expect(await doorOffences(SOURCE_ROOT, () => false)).toEqual([])
  })

  it('nothing in src/ reads a GitHub credential from the environment', async () => {
    // idp-agent holds no GitHub credential (§ 5): gh and git read their own.
    expect(await credentialOffences(SOURCE_ROOT)).toEqual([])
  })

  it('in tests/, only tests/live/ and tests/support/fake-gh.ts name a door', async () => {
    // They try the doors; every other test takes them from DOORS, GIT_DOORS and DOOR_WORDS.
    expect(await doorOffences(TESTS_ROOT, (name) => name.startsWith('live/') || name === 'support/fake-gh.ts')).toEqual([])
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
    for (const layer of ['agents', 'cli', 'confine', 'context', 'core', 'forge', 'llm', 'process', 'scaffold', 'trace']) {
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
    const spawns = { 'spawns.ts': { calls: 1, env: ['gitEnvironment'] } }
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

    // Handed an environment — a test's — the function still starts from
    // spawnedEnvironment, so the call is as safe as one with none: what it is
    // handed is named nowhere but inside `spawnedEnvironment(…)`.
    const handed = good
      .replace('function gitEnvironment()', 'function gitEnvironment(env?: NodeJS.ProcessEnv)')
      .replace('...spawnedEnvironment()', '...spawnedEnvironment(env)')
      .replace('{ env: gitEnvironment() }', '{ env: gitEnvironment(given) }')
    expect(await spawnOffences(await tree({ 'spawns.ts': handed }), spawns)).toEqual([])
    // A body that calls spawnedEnvironment and hands the raw one on anyway.
    const leaked = handed.replace(
      'return { ...spawnedEnvironment(env), LC_ALL: "C" }',
      'void spawnedEnvironment(env)\n  return { ...env }',
    )
    expect(await spawnOffences(await tree({ 'spawns.ts': leaked }), spawns)).toEqual([
      'spawns.ts: gitEnvironment names env outside spawnedEnvironment(…)',
    ])
    const counted = handed.replace('...spawnedEnvironment(env)', '...spawnedEnvironment(env), ...arguments[0]')
    expect(await spawnOffences(await tree({ 'spawns.ts': counted }), spawns)).toEqual([
      'spawns.ts: gitEnvironment names arguments outside spawnedEnvironment(…)',
    ])
    const unpacked = handed.replace('gitEnvironment(env?: NodeJS.ProcessEnv)', 'gitEnvironment({ ...env }: NodeJS.ProcessEnv)')
    expect(await spawnOffences(await tree({ 'spawns.ts': unpacked }), spawns)).toEqual([
      'spawns.ts: gitEnvironment destructures a parameter, which no rule can follow',
    ])

    // Two calls, two functions — `gitIn`'s and `pushIn`'s: each call is given
    // one of them, and each of them starts from spawnedEnvironment.
    const twice = { 'spawns.ts': { calls: 2, env: ['gitEnvironment', 'pushEnvironment'] } }
    const both = [
      handed,
      'function pushEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {',
      '  return { ...spawnedEnvironment(env), GIT_SSH_COMMAND: "kept" }',
      '}',
      "const push = () => execFile('git', ['push'], { env: pushEnvironment(given) }, (error) => {})",
      '',
    ].join('\n')
    expect(await spawnOffences(await tree({ 'spawns.ts': both }), twice)).toEqual([])
    const leakedSecond = both.replace('return { ...spawnedEnvironment(env), GIT_SSH_COMMAND: "kept" }', 'void spawnedEnvironment(env)\n  return { ...env }')
    expect(await spawnOffences(await tree({ 'spawns.ts': leakedSecond }), twice)).toEqual([
      'spawns.ts: pushEnvironment names env outside spawnedEnvironment(…)',
    ])
    const crossed = both.replace('{ env: pushEnvironment(given) }', '{ env: gitEnvironment(given) }')
    expect(await spawnOffences(await tree({ 'spawns.ts': crossed }), twice)).toEqual([])
    const bare = both.replace('{ env: pushEnvironment(given) }', "{ cwd: '/' }")
    expect(await spawnOffences(await tree({ 'spawns.ts': bare }), twice)).toEqual([
      'spawns.ts: execFile(…) is not given env: gitEnvironment() or pushEnvironment()',
    ])
  })

  it('refuses every way src/ can name a door', async () => {
    // One probe per word: a string, a template literal, a second array
    // element. Built from DOOR_WORDS, so this file spells none of them.
    const probes: Record<string, string> = {}
    DOOR_WORDS.forEach((word, at) => {
      probes[`cli/string-${at}.ts`] = `export const x = ${JSON.stringify(word)}\n`
      probes[`forge/template-${at}.ts`] = `export const x = \`gh ${word} now\`\n`
      probes[`process/array-${at}.ts`] = `export const x = ['gh', ${JSON.stringify(`${word} 1`)}]\n`
    })
    const [put, patch, del] = ['put', 'patch', 'delete'].map((method) => method.toUpperCase())
    Object.assign(probes, {
      'cli/single.ts': `export const m = '${put}'\n`,
      'cli/double.ts': `export const m = "${del}"\n`,
      'cli/flag.ts': `export const m = '--method=${patch}'\n`,
      'cli/path.ts': `export const p = \`/repos/acme/iac/pulls/1/${'merge'}\`\n`,
    })
    const refused = await tree(probes)
    const found = await doorOffences(refused, () => false)
    const expected = [
      ...DOOR_WORDS.flatMap((word, at) => [
        `cli/string-${at}.ts names ${word}`,
        `forge/template-${at}.ts names ${word}`,
        `process/array-${at}.ts names ${word}`,
      ]),
      `cli/single.ts names ${put}`,
      `cli/double.ts names ${del}`,
      `cli/flag.ts names ${patch}`,
      `cli/path.ts names /${'merge'}`,
    ]
    // A probe of `/merges` holds no `/merge` as a word, and the others each
    // hold their own word alone.
    expect(found.sort()).toEqual([...new Set(expected)].sort())

    // The same words in a comment, and the words the doors' boundaries keep
    // apart from them, pass.
    const passing = await tree({
      'cli/said.ts': `${DOOR_WORDS.map((word) => `// ${word}`).join('\n')}\n/* ${DOOR_WORDS.join(' ')} */\nexport const x = 1\n`,
      'process/kept.ts': [
        "export const lease = '--force-with-lease=refs/heads/idp-agent/x-0123abcd:'",
        "export const flag = '--no-follow-tags'",
        "export const base = ['merge-base', '--is-ancestor']",
        "export const key = 'branch.main.merge'",
        "export const words = ['INPUT', 'DELETED', 'put']",
        '',
      ].join('\n'),
    })
    expect(await doorOffences(passing, () => false)).toEqual([])

    // The tests-side predicate: the live test and the doors' own file try
    // them; any other test takes them from there.
    const tests = await tree({
      'live/github/doors.ts': `export const d = ${JSON.stringify(DOOR_WORDS[0])}\n`,
      'support/fake-gh.ts': `export const d = ${JSON.stringify(DOOR_WORDS[0])}\n`,
      'unit/probe.test.ts': `const d = ${JSON.stringify(DOOR_WORDS[0])}\n`,
    })
    const allowed = (name: string): boolean => name.startsWith('live/') || name === 'support/fake-gh.ts'
    expect(await doorOffences(tests, allowed)).toEqual([`unit/probe.test.ts names ${DOOR_WORDS[0] ?? ''}`])
  })

  it('refuses every way src/ can read a GitHub credential', async () => {
    const refused = await tree({
      'cli/dot.ts': 'export const t = process.env.GH_TOKEN\n',
      'cli/index.ts': "export const t = process.env['GITHUB_TOKEN']\n",
      'cli/template.ts': 'export const t = env[`GH_TOKEN`]\n',
      'cli/destructured.ts': 'export const { GH_TOKEN } = process.env\n',
      'forge/reflect.ts': "export const t = Reflect.get(env, 'GITHUB_TOKEN')\n",
      'process/compare.ts': "export const is = (name: string) => name === 'GH_TOKEN'\n",
      'context/other.ts': 'export const t = env.GH_OTHER_TOKEN\n',
      'process/gh.ts': [
        "export const GH_REMOVED: readonly string[] = ['GIT_*', 'GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_TOKEN']",
        "export const t = env['GITHUB_ENTERPRISE_TOKEN']",
        '',
      ].join('\n'),
      'cli/x.ts': "export const t = 'GH_ENTERPRISE_TOKEN'\n",
      'forge/github/x.ts': "export const hosts = 'hosts.yml'\n",
    })
    expect((await credentialOffences(refused)).sort()).toEqual(
      [
        'cli/dot.ts names GH_TOKEN',
        'cli/index.ts names GITHUB_TOKEN',
        'cli/template.ts names GH_TOKEN',
        'cli/destructured.ts names GH_TOKEN',
        'forge/reflect.ts names GITHUB_TOKEN',
        'process/compare.ts names GH_TOKEN',
        'context/other.ts names GH_OTHER_TOKEN',
        // Inside GH_REMOVED, only the two Enterprise names; outside it, none.
        'process/gh.ts names GH_TOKEN',
        'process/gh.ts names GITHUB_ENTERPRISE_TOKEN',
        'cli/x.ts names GH_ENTERPRISE_TOKEN',
        'forge/github/x.ts names hosts.yml',
      ].sort(),
    )
    const passing = await tree({
      'process/gh.ts': [
        "export const GH_REMOVED: readonly string[] = ['GIT_*', 'GH_HOST', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']",
        "export const kept = ['GH_CONFIG_DIR']",
        '',
      ].join('\n'),
      'process/environment.ts': '// A GITHUB_TOKEN is kept: git may need one, and it is not this tool\'s.\nexport const x = 1\n',
    })
    expect(await credentialOffences(passing)).toEqual([])
  })

  it('refuses every module but project-fs and forge/ that loads the git launcher', async () => {
    const root = await tree({
      // What a reviewer planted, measured: each read any tracked file past
      // project-fs's secret filter, and passed every rule.
      'context/backstage/probe-git.ts': "import { gitIn } from '../../process/git.js'\n",
      'llm/probe-git.ts': "import { gitIn } from '../process/git.js'\n",
      'cli/late.ts': "const { gitIn } = await import('../process/git.js')\n",
      'cli/named.ts': 'const m = await import(name)\n',
      // A second door inside process/, or one of the named modules handing it on.
      'process/index.ts': "export { gitIn } from './git.js'\n",
      'forge/local/passed.ts': "export { gitIn } from '../../process/git.js'\n",
      // A type is erased, the environment is no process, and these two may.
      'cli/typed.ts': "import type { Git } from '../process/git.js'\n",
      'context/backstage/transport.ts': "import { BACKSTAGE_TOKEN_VARIABLE } from '../../process/environment.js'\n",
      'context/project-fs/snapshot.ts': "import { GitError, gitIn } from '../../process/git.js'\n",
      'forge/local/forge.ts': "import { gitIn, type Git } from '../../process/git.js'\nexport type { Git } from '../../process/git.js'\n",
      'process/git.ts': "import { spawnedEnvironment } from './environment.js'\n",
    })
    expect((await launcherOffences(root)).sort()).toEqual(
      [
        'context/backstage/probe-git.ts → ../../process/git.js',
        'llm/probe-git.ts → ../process/git.js',
        "cli/late.ts → '../process/git.js' at run time",
        'cli/named.ts loads name at run time: no rule can tell what it names',
        'process/index.ts → ./git.js',
        'forge/local/passed.ts hands on ../../process/git.js',
      ].sort(),
    )
  })

  it('refuses every module but the provider that loads the catalogue cache', async () => {
    const root = await tree({
      // A command that answers from a copy, past the pre-pass and the reader.
      'cli/cached.ts': "import { catalogueCache } from '../context/backstage/cache.js'\n",
      'context/backstage/late.ts': 'const store = await import(name)\n',
      // The provider handing the store on is a second door.
      'context/backstage/provider.ts':
        "import { catalogueCache } from './cache.js'\nexport { catalogueCache } from './cache.js'\n",
      // A type is erased, and names nothing that can read.
      'cli/typed.ts': "import type { Kept } from '../context/backstage/cache.js'\n",
      'context/backstage/cache.ts': "import { rename } from 'node:fs/promises'\n",
    })
    expect((await cacheOffences(root)).sort()).toEqual(
      [
        'cli/cached.ts → ../context/backstage/cache.js',
        'context/backstage/late.ts loads name at run time: no rule can tell what it names',
        'context/backstage/provider.ts hands on ./cache.js',
      ].sort(),
    )
  })

  it('refuses every module but the four named that loads the confinement primitive', async () => {
    const root = await tree({
      // A writer and a reader no other rule would see: neither names an fs function.
      'cli/commands/probe-write.ts': "import { createNew } from '../../confine/confine.js'\n",
      'context/backstage/probe-read.ts': "import { openToRead } from '../../confine/confine.js'\n",
      'forge/local/late.ts': "const { createNew } = await import('../../confine/confine.js')\n",
      'agents/named.ts': 'const m = await import(name)\n',
      // One of the three handing it on is a second door.
      'context/iac-fs/snapshot.ts': "export { openToRead } from '../../confine/confine.js'\n",
      // A type is erased, and these may.
      'cli/typed.ts': "import type { LinkTarget } from '../confine/confine.js'\n",
      'scaffold/write.ts': "import { createNew } from '../confine/confine.js'\n",
      'context/project-fs/snapshot.ts': "import { openToRead } from '../../confine/confine.js'\n",
      'context/backstage/cache.ts': "import { openNew } from '../../confine/confine.js'\n",
      'confine/confine.ts': "import { open } from 'node:fs/promises'\n",
    })
    expect((await confineOffences(root)).sort()).toEqual(
      [
        'cli/commands/probe-write.ts → ../../confine/confine.js',
        'context/backstage/probe-read.ts → ../../confine/confine.js',
        "forge/local/late.ts → '../../confine/confine.js' at run time",
        'agents/named.ts loads name at run time: no rule can tell what it names',
        'context/iac-fs/snapshot.ts hands on ../../confine/confine.js',
      ].sort(),
    )
  })

  it('refuses a package, a layer and a built-in forge/ was not given', async () => {
    const root = await tree({
      // A reviewer's probe: a socket and a read, and every rule passed.
      'forge/local/probe-net.ts': "import { request } from 'node:http'\nimport { readFile } from 'node:fs/promises'\n",
      // A git client the DISK list does not name.
      'forge/local/client.ts': "import { execa } from 'execa'\n",
      'forge/local/reader.ts': "import { readRepository } from '../../context/iac-fs/snapshot.js'\n",
      'forge/local/late.ts': "const cp = await import('node:child_process')\nconst m = await import(name)\n",
      'forge/local/forge.ts': [
        "import { createHash } from 'node:crypto'",
        "import path from 'node:path'",
        "import type { Cleared } from '../../core/plan/clear.js'",
        "import { GitError, gitIn, type Git } from '../../process/git.js'",
        "import { ForgeInputError } from '../errors.js'",
        '',
      ].join('\n'),
    })
    expect((await forgeImportOffences(root)).sort()).toEqual(
      [
        'forge/local/probe-net.ts imports node:http',
        'forge/local/probe-net.ts imports node:fs/promises',
        'forge/local/client.ts imports execa',
        'forge/local/reader.ts imports ../../context/iac-fs/snapshot.js',
        'forge/local/late.ts imports node:child_process',
        'forge/local/late.ts loads name at run time: no rule can tell what it names',
      ].sort(),
    )
  })

  it('refuses every way a layer but cli/ can load forge/, and lets a type through', async () => {
    const root = await tree({
      'context/value.ts': "import { ForgeInputError } from '../forge/errors.js'\n",
      'context/side.ts': "import '../forge/local/forge.js'\n",
      'context/passed.ts': "export { openLocalForge } from '../forge/local/forge.js'\n",
      'context/late.ts': "const forge = await import('../forge/local/forge.js')\n",
      'context/named.ts': 'const forge = await import(name)\n',
      // A statement with no quote before an import is not the import's clause.
      'core/after.ts': "export type Shape = { a: number }\nimport { x } from '../forge/errors.js'\n",
      'agents/typed.ts': "import type { ForgeProvider } from '../forge/provider.js'\n",
      'agents/said.ts': "// import { x } from '../forge/errors.js'\nexport const y = 1\n",
      'context/forge/own.ts': "import { z } from './z.js'\n",
      'context/forge/z.ts': 'export const z = 1\n',
      'cli/submit.ts': "import { openLocalForge } from '../forge/local/forge.js'\n",
      'forge/local/forge.ts': "import type { ForgeProvider } from '../provider.js'\n",
      // A reviewer's relay, measured: nothing refused a layer importing a
      // cli/ module that imports the forge. Two hops, or three, reach it all
      // the same; a type imported from the relay loads nothing.
      'cli/relay.ts': "import { ForgeInputError } from '../forge/errors.js'\nexport const relay = 1\n",
      'context/via-cli.ts': "import { relay } from '../cli/relay.js'\n",
      'llm/via-context.ts': "import './helper.js'\n",
      'llm/helper.ts': "export { relay } from '../context/via-cli.js'\n",
      'agents/typed-relay.ts': "import type { Relay } from '../cli/relay.js'\n",
      // A type written as `import('…')` is loaded as far as a rule can tell:
      // `import type` says the same and is read as erased.
      'agents/inline.ts': "type B = import('../forge/provider.js').Base\n",
    })
    expect((await forgeReachOffences(root)).sort()).toEqual(
      [
        'context/value.ts → ../forge/errors.js',
        'context/side.ts → ../forge/local/forge.js',
        'context/passed.ts → ../forge/local/forge.js',
        "context/late.ts → '../forge/local/forge.js' at run time",
        'context/named.ts loads name at run time: no rule can tell what it names',
        'core/after.ts → ../forge/errors.js',
        'context/via-cli.ts → ../cli/relay.js → ../forge/errors.js',
        'llm/via-context.ts → ./helper.js → ../context/via-cli.js → ../cli/relay.js → ../forge/errors.js',
        'llm/helper.ts → ../context/via-cli.js → ../cli/relay.js → ../forge/errors.js',
        "agents/inline.ts → '../forge/provider.js' at run time",
      ].sort(),
    )
  })
})
