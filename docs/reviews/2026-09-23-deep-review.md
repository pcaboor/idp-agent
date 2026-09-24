# Deep code review — idp-agent at `eee67d6`

**Date** 2026-09-23 · **Commit reviewed** `eee67d6` (`main`) · **Method** a multi-agent
review run with Claude Code: 13 review dimensions plus 4 targeted follow-ups. Every finding
was put to an adversarial verifier, and every one still rated critical or high after that
verification went to a second, independent skeptic. **212 findings kept**: 153 confirmed,
59 partially confirmed, none fully refuted.

This is a dated snapshot of `eee67d6`, not a description of later code.

The two critical findings were reproduced by hand. A `plan` run against a grant file with
no leading `---` printed `nothing to change.` and exited 0. The `answer` and `verdict` tool
schemas serialise with no root `type: "object"`, and the SDK passes them into
`input_schema` verbatim. The Anthropic rejection itself is inferred from the API's
requirement, not observed: no key was used.

Sections 1 to 7 are the report as delivered, translated from French. The index at the end
has one row per finding, generated from the review's data.

---

> Severity scale: **critical**, **high**, **medium**, **low**, **info**. For a merged
> finding, the severity kept is the highest among those the counter-verification confirmed.
> Where it was revised down, that is stated. No finding is marked "disputed": the
> counter-verification refuted none.
>
> The work in progress on `fix/reviewer-facts` when the review started (`repair.ts`,
> `reviewer.ts`, `plan.ts`, `sign.ts`) was committed while it ran (`d63edcb`, `e785f97`,
> `00c8597`, `eee67d6`). The tapes were re-recorded and the suite passes: 790/790.

## 1. Verdict

**Portfolio credibility.** The engine is of a standard rare for a personal project. The
trust boundary is structural: closed `Operation` union, strict schemas, engine-computed
paths, frozen `SignedPlan`. `core/` is pure. There are 790 offline tests in about 2 s, the
architecture tests walk the transitive closure of imports, the ADRs are short and accurate,
and the adversarial audit is kept as tests. A staff engineer reading the code will be
impressed. First contact nevertheless says the opposite:

- `SECURITY.md` announces "stage 1, no model, no network call";
- `pnpm demo` stops at step 2;
- the README, AGENTS.md and reality give three different test counts;
- every diff writes `company.fr/env`;
- the docs still describe `withAnswers`, which no longer exists.

For a project whose central argument is "measure rather than assert", these gaps cost more
than elsewhere.

**Plug-and-play trial and foundation for plugins.** Today, an employer's trial on their own
stack almost certainly fails.

- **Anthropic key**: `ask` and `plan` break on the schema of the `answer` and `verdict`
  tools, and no Anthropic tape has ever been recorded.
- **Question mode**: `ask`, `graph` and `show` read only the fictional information system
  (SI).
- **Real Backstage catalogue**: it is largely refused (kinds, abbreviated owner,
  namespaces). A single foreign YAML file blocks every plan.
- **Interactive loop**: it cannot keep an owner the user has just typed, and `init` ends in
  a dead end.
- **The sentence the project swears never to say wrongly**: "nothing to change." on exit 0
  is false as soon as a file has no `---` or is indented by 4 spaces.

On the foundation side, the seams exist (`LlmClient`, `MainDeps`, `EventSink`, `Ask`,
`ContextProvider`). But the domain model is frozen at compile time, the gate sequence is
coded three times, there is no session, no router, no cancellation, and `ContextProvider`
has a single implementation. In short, the engine is good but the front door is broken.
Reading real repositories and the YAML surgery must be repaired before adding a single
plugin.

## 2. The 10 priorities

1. **Make Anthropic usable.** The `answer` and `verdict` tools must have a root
   `type: "object"`, there must be one contract test per provider, and at least one
   Anthropic tape. *Why:* a third of the announced providers do not work from the first run.
   This is the plug-and-play promise and "no privileged provider". *Ids:*
   gap-provider-matrix-1, gap-provider-matrix-5, tests-10. *Effort:* S (plus a
   re-recording).
2. **Make the YAML surgery honest.** `appendSequenceItem` must throw when the entity or
   `spec:` cannot be found. It also needs a post-condition by re-parse (the requested effect
   is present and the document has no YAML error), and a single reader that turns
   `document.errors` into a rejection. *Why:* it is the only "never wrong on exit 0"
   guarantee, and stage 5 will write these bytes. *Ids:* gap-stage5-readiness-1,
   core-yaml-1, core-plan-6, runtime-probe-2, tests-1, core-yaml-2, core-yaml-3, security-7,
   domain-backstage-3, runtime-probe-4. *Effort:* M.
3. **Add `--repo` to `ask`, `graph` and `show`**, going through `iac-fs`, and say on stderr
   when it is the demo SI being read. *Why:* it is the "questions about the SI" half of the
   goal, and an employer runs into it on the first command. *Ids:* product-gap-1,
   agents-llm-3, cli-ux-3, domain-backstage-5, architecture-3, build-ci-1, runtime-probe-7,
   gap-ask-grounding-1. *Effort:* S.
4. **Make existing repositories hold.** The re-check must compare violations before and
   after and refuse only those the plan introduces. A pre-existing violation must never be
   sent back to the Architect. Unmodelled kinds and non-entity YAML must be skipped with a
   report, and the read schema must be tolerant. *Why:* without this, no employer will ever
   see a diff on their repository, and the intent route burns three paid attempts. *Ids:*
   product-gap-2, core-plan-7, cli-ux-4, domain-backstage-2, architecture-4,
   runtime-probe-6, core-yaml-11, product-gap-3, runtime-probe-5, domain-backstage-1.
   *Effort:* M.
5. **A single provenance (request + answers, indexed by path)**, read by `deriveOwners`, the
   policies and `signPlan`. *Why:* the question → answer loop, the heart of the future
   chat, cannot complete for an access whose owner cannot be derived. *Ids:* core-plan-2,
   agents-llm-1, cli-ux-2, architecture-2. *Effort:* S.
6. **Harden the environment gates.** `cross-environment-consumer` must read `metadata.env`
   alone and refuse a name that contradicts the declared environment. The environment of the
   grant an `update-entity` targets must be asked, and `echoes` must tokenise on whole
   tokens. *Why:* "an environment is never inferred" is the central guarantee, and a natural
   name gets around it. *Ids:* core-plan-1, core-plan-3, core-plan-4. *Effort:* M.
7. **Fix project-fs's secret filter.** Examine every match, not only the first. Add the
   `sk-ant-`/`sk-proj-`/`github_pat_` prefixes, read only files tracked by git, and remove
   the false positives (`jsonwebtoken`, `existingSecret`). *Why:* a secret sent to the
   provider, and a manifest wrongly excluded. *Ids:* security-1, security-2,
   gap-init-real-repos-4, security-3. *Effort:* M.
8. **Make "already declared" exact.** `restates` must compare consumers, target,
   environment and owner. Two operations targeting the same ref must be refused, and
   `update-entity` must get a real `already-declared` outcome. *Why:* otherwise the tool
   asserts on exit 0 an access that does not exist. *Ids:* runtime-probe-1, core-plan-5,
   wip-diff-2, core-plan-12. *Effort:* M.
9. **Make `init` usable on a real service.** Read the signal files first (manifests,
   CODEOWNERS, Chart…), wire `ask` (plus `--owner`, `--lifecycle`, `--name`), detect an
   existing `catalog-info` through the parser and read its `before` outside the budget.
   *Why:* it is the first onboarding gesture, and today it ends in a dead end or a
   duplicate. *Ids:* gap-init-real-repos-1, gap-init-real-repos-2, gap-init-real-repos-3,
   core-yaml-4, gap-stage5-readiness-8. *Effort:* M.
10. **Repair first contact.** Rewrite `SECURITY.md` for stage 4, fix the demo and the
    examples table, name the key variables and provide a `.env.example`, exit 2 with a clean
    message when the key is missing, and put "Backstage" and a real intent → diff example
    on the README's first screen. *Why:* it is what recruiters and CISOs read in the first
    two minutes. *Ids:* docs-3, security-9, docs-1, build-ci-4, product-gap-12, docs-2,
    docs-4, docs-5, cli-ux-15, runtime-probe-14, build-ci-11. *Effort:* S.

## 3. Findings by theme

### Security

**[high] project-fs: a single placeholder before a literal secret lets the whole file
through** — `src/context/project-fs/snapshot.ts:704`
`ASSIGNED_SECRET.exec(text) ?? SQL_PASSWORD.exec(text) ?? PHP_DEFINE.exec(text)` examines
only the first match, with non-global regexes. As soon as a first value is substituted
(`${DB_PASSWORD}`, or `changeme` if it is at least 6 characters long), the literals that
follow get through. *Scenario:* a docker-compose with `POSTGRES_PASSWORD: ${…}` followed by
`PGADMIN_DEFAULT_PASSWORD: Adm1nProd!` is read, and the Inspector sends it to the provider.
*Recommendation:* `matchAll` over global regexes, exclusion as soon as one value is
literal, a test of the mixed case, and fix the comment at lines 86-95. *Effort:* S ·
*Ids:* security-1 (originally critical, revised to high: `SECURITY.md` still files this
guarantee under "not yet built").

**[high] project-fs: the deny list misses common key formats, including those of the
tool's own providers** — `src/context/project-fs/snapshot.ts:128`
`/\bsk-[A-Za-z0-9]{20,}/` stops at the hyphen of `sk-ant-…` and `sk-proj-…`. Also missing:
`github_pat_`, `sk_live_`, `npm_`, `hf_`, Slack webhooks, `AccountKey=`, `Pwd=`, the base64
of a `kind: Secret`, and base64-encoded PEM outside a three-byte alignment. `.gitignore` is
not honoured. *Scenario:* `anthropic: sk-ant-api03-…` in `config/llm.yaml`, or
`OpenAI("sk-proj-…")`, goes to the provider. *Recommendation:* an allow list for what the
Inspector actually needs to read, `git ls-files`, masking values rather than excluding the
file, patterns from a maintained set (gitleaks), a `kind: Secret` rule. *Effort:* M ·
*Ids:* security-2.

**[medium] The current directory goes to the model with no guard and no consent** —
`src/cli/index.ts:436`
`plan "<intent>"` and `init` read `process.cwd()` without checking that it is a repository.
Run from `~`, the tool makes `Documents/rh/salaires.csv` readable by the Inspector (caps:
200 files, 1 MB). *Recommendation:* require a git root, refuse `$HOME` and `/`, an explicit
`--project`, and the announcement "N files readable by <provider>". *Effort:* M · *Ids:*
security-3 (originally high, revised to medium: it is a usage error, and the behaviour is
documented).

**[medium] Terminal escape sequences unfiltered outside the plan route** —
`src/cli/commands/ask.ts:54`
`plain()` is applied at four sites only. Model text in `ask` (the `unanswerable` reason at
line 54, the Supervisor excerpt at line 35), the context lines of the diff (`paintDiff`),
`validate`'s file names and the environments quoted in policy messages reach the terminal
raw. `SECURITY.md:49` claims the opposite. *Scenario:* an OSC 52 comment committed in an
access file replaces the clipboard, or `ESC[1A ESC[2K` erases the `+` line the reviewer is
meant to see. *Recommendation:* filter at the output points (`out`/`err`),
`paintDiff(plain(diff))`, and a property test "no \u001b outside colours". *Effort:* S ·
*Ids:* security-4, cli-ux-9, gap-ask-grounding-10, runtime-probe-12.

**[medium] Purely lexical confinement on the write side and on the declarations-repository
side** — `src/core/paths/entity-path.ts:73`, `src/context/iac-fs/snapshot.ts:46`
`assertInsideRepo` does not resolve symbolic links. `init platform` writes through
`catalog -> ../outside` (three `.witness.yml` files created outside the root). iac-fs reads
a `.yml` linked to the outside and *silently* skips a linked directory. Yet this is the
repository stage 5 will write to. *Recommendation:* a single physical-confinement primitive
(lstat → realpath → `O_NOFOLLOW`) taken from project-fs, with named rejections in the
snapshot, and rephrase `SECURITY.md:16` in the meantime. *Effort:* M · *Ids:* core-yaml-5,
security-8, runtime-probe-11, gap-stage5-readiness-4.

**[medium] The Inspector's facts vouch for themselves, owner included** —
`src/cli/commands/init.ts:278`
The facts `name`, `type`, `lifecycle` and `owner` enter `answered` and are signed `echoed`
without any file read stating them. Even with an empty snapshot, an owner is printed on
exit 0. The limit is documented (init.ts:126-130), but the comment at lines 106-107
promises too much. *Recommendation:* a textual witness (the value must appear in a file
read), otherwise `novel`, which becomes a question; an `inspected` class for the owner. To
be done before stage 5 writes. *Effort:* S · *Ids:* gap-init-real-repos-5, security-5.

**[medium] `create-catalog-info.repoPath` is a free path, signed `echoed` on the `--from`
route** — `src/core/schemas/plan.ts:327`
`planSchema` accepts `repoPath: '../../../../etc/cron.d/x'` or `.git/hooks/post-checkout`,
and the signature vouches for it. This is harmless today only because `planEdits` discards
the operation. The brief's claim ("a Plan carrying a path outside the repository is
rejected") is false. *Recommendation:* `z.literal(CATALOG_INFO)` or an engine-computed
path, an allow list on the writer side, refusal of hidden segments. *Effort:* S · *Ids:*
gap-stage5-readiness-2.

- **[low]** No policy links an operation's consumer to the request. It is a documented
  choice, but "cannot widen permissions" (`SECURITY.md:86`) is too strong — security-6.
- **[low]** The recordings guard (`/authorization|api[_-]?key|bearer/`) would not detect a
  real key, and `providerMetadata` is recorded without being used — security-10.
- **[low]** OpenAI: `store` is not sent and so defaults to `true`, which means the files
  read are retained at OpenAI; pass `store: false` — gap-provider-matrix-6.
- **[low]** The generated `validate.yml` workflow has neither `permissions: contents: read`
  nor `persist-credentials: false` — build-ci-7.
- **[low]** Free text from the repository (`spec.type`, the environment annotation), line
  breaks included, enters the Supervisor's and the Analyst's prompts — gap-ask-grounding-6.
- **[low]** An environment annotation planted in the repository reaches the Reviewer,
  unbounded, under the heading of the "engine's facts" — wip-diff-9.

### Core correctness (YAML, plan, gates)

**[critical] "nothing to change." on exit 0 when nothing was done** —
`src/core/yaml/surgery.ts:202`, `src/cli/commands/plan.ts:332`
The surgery recognises a document only behind an exact `---` line and a `  name:` indented
by two spaces, with no comment. Otherwise it returns the text unchanged
(`if (target === undefined) return text`). `planEdits` takes that text for "already
listed", nothing goes into `dropped`, and `changedNothing` concludes success. The
re-check always classifies an `update-entity` as `unresolved`: it can therefore never be
told apart from a real no-op. Shapes reproduced: a file without `---` (the most common
shape of a catalog-info), 4-space indentation, a BOM, a comment after
`metadata:`/`spec:`/`name:`, a quoted key. `validate` judges all these shapes compliant.
*Scenario:* "give billing-api access to payments-db" on an employer's real repository
gives "nothing to change.", exit 0. They believe the access is in place when it is not,
and at stage 5 the branch would be empty. *Recommendation:* `SurgeryError` when the
target or `spec:` cannot be found, a labelled result `appended | already-listed`, a
post-condition by re-parse, a real `already-declared` outcome for an update, and reverse
the burden of proof in `changedNothing`. Eventually, locate through the `yaml` library's
AST (see core-yaml-10).
*Effort:* M · *Ids:* gap-stage5-readiness-1, core-yaml-1, core-plan-6, runtime-probe-2,
tests-1 (critical severity kept for gap-stage5-readiness-1, high for the other
verifications).

**[high] The surgery writes a second `dependencyOf:` key: invalid YAML, rights changed
without a word** — `src/core/yaml/surgery.ts:166`
A column-0 comment closes the `spec` block (`/^\S/`), and `"dependencyOf":` or
`dependencyOf :` are not recognised (`startsWith`). The function therefore opens a new
key: `DUPLICATE_KEY`. Depending on the reader, the new consumer or the old ones lose
access, and the re-check sees nothing (see the next finding). *Recommendation:* check the
key's absence in the AST, treat comments as transparent, re-parse and refuse if
`doc.errors` is not empty. *Effort:* M · *Ids:* core-yaml-2.

**[high] `document.errors` is ignored everywhere, and a single unreadable file crashes
`validate`** — `src/core/yaml/serialize.ts:93`, `src/context/iac-fs/snapshot.ts:74`
The three readers (`parseDocuments`, `readOne`, `FixtureProvider`) call `toJS()` without
consulting `errors`. An unclosed bracket or a duplicate key gives "33 entities, 0
violations", exit 0, with a partial or "last one wins" value. The re-check re-reads the
bytes with that same reader, so it cannot detect a surgery that breaks the syntax.
Conversely, an alias bomb, a broken link, an EACCES or an EISDIR make `validate` exit on a
raw Node stack trace, with no report on the other files. *Scenario:* a conflict resolution
leaves two `owner:` keys, the generated CI passes, and Backstage then refuses the file.
*Recommendation:* a single reader in `core/` that turns `errors[0]` into an
`invalid-entity` rejection with line and column, a per-file try/catch that produces a
rejection, and an lstat before `readFile`. *Effort:* S · *Ids:* core-yaml-3, security-7,
domain-backstage-3, runtime-probe-4, runtime-probe-8 (crash part).

**[high] `restates` compares only the level: a false "the repository already says it"** —
`src/core/plan/grant.ts:97`
A creation that reuses an existing grant's name with another consumer, another owner or
another environment gives "nothing to change — the repository already says it", exit 0,
and the Reviewer receives the same false fact. Two same-named operations in one plan
merge, and the second disappears. The Architect's prompt precisely encourages it to
re-propose what exists ("propose it ANYWAY"). *Recommendation:* equality by inclusion
(proposed consumers and `dependsOn` ⊆ declared, same env and same owner), otherwise
`differs`; refuse at the first gate two operations targeting the same ref. *Effort:* M ·
*Ids:* runtime-probe-1, core-plan-5.

**[high] An owner answered at the prompt is withdrawn on the next round, and an answered
environment escapes the policies** — `src/core/plan/derive.ts:216`
Since `84fde41`, answers go into `SignatureContext.answered`, which only `signPlan` reads.
`deriveOwners` protects only an owner that appears in the intent, then withdraws any other
value (`WITHDRAWN`, line 264). For a consumer absent from the catalogue or an access shared
by two teams, the question comes back three times, then the run exits 3 with "Fill them in
and run this again". In addition, `checkPolicies` computes `asked` from the intent alone: a
`dev` answered at the prompt lets through an access on `orders-db-prod` that a `dev` typed
in the request would have refused. *Recommendation:* a single provenance object (intent +
answers by path) for `deriveOwners`, the policies and `signPlan`, two regression tests on a
grant, and remove the references to `withAnswers`. *Effort:* S · *Ids:* core-plan-2,
agents-llm-1, cli-ux-2, architecture-2.

**[high] `cross-environment-consumer` reads the name's segments as a scope** —
`src/core/plan/policies.ts:361`
`environmentsTouched` adds the environments contained in `metadata.name`. That is cautious
for `environment-mismatch`, but here it widens the rule. An `env: dev` access on
`orders-db-prod` is refused if it is named `…-dev`, and accepted, exit 0 and a diff to show
for it, if it is named `billing-api-orders-db-prod`, the most natural name.
*Recommendation:* compare against `metadata.env` alone, and refuse a name whose environment
contradicts `metadata.env`. *Effort:* S · *Ids:* core-plan-1 (originally critical, revised
to high: the request must name prod, and nothing is written).

**[high] `update-entity`: the environment of the extended grant is never asked** —
`src/core/plan/policies.ts:249`
A patch has no environment leaf, the check only runs `if (asked.length > 0)`, and
Components declare no environment. The model therefore freely chooses whether to extend
the dev grant or the prod grant. The only remaining control is the Reviewer, whose prompt
says "do not re-check" the environment. *Recommendation:* a signed `env` field in the
patch, or a question whenever the request does not name the environment of the targeted
grant (§7.5 provides for a "picker, never a default"). *Effort:* M · *Ids:* core-plan-3.

**[medium] `echoes` reads "non-prod", "pre-prod" and "hors-prod" as a request for prod** —
`src/core/plan/echoes.ts:35`
The hyphen serves as a word boundary, so `prod` is `echoed` and `environment-mismatch`
takes it as requested. Conversely, `preprod` is not recognised in "pre-prod". Same cause on
the owner side: `lion` is recognised in `lion-ops`. *Recommendation:* equality on maximal
tokens `[\p{L}\p{N}._-]+`. *Effort:* S · *Ids:* core-plan-4 (originally high, revised to
medium).

**[medium] The `SignedPlan` brand is forged by spread, and it is issued from gate [2]** —
`src/core/plan/sign.ts:83`
`{ ...signed, plan: other }` and `structuredClone(signed)` compile as `SignedPlan`.
`Map.prototype.set.call` bypasses the seal, and `classified[i]` is not frozen. Above all,
the brand exists before the policies, the re-check and the Reviewer: it cannot serve as
proof of authorisation for a writer. *Recommendation:* at stage 5, an `ApprovedChange`
issued by a single function after the five gates and registered in a private `WeakSet`;
`SignedPlan` as a class with private fields. *Effort:* M · *Ids:* core-plan-9,
gap-stage5-readiness-5.

- **[low]** recheck and edits diverge: for a duplicate, the last declaration wins in one
  and the first in the other; an update always receives `unresolved` — core-plan-12.
- **[low]** CRLF files: the inserted line is LF, hence mixed line endings — core-yaml-7.
- **[low]** A consumer already present but followed by a comment is added a second time —
  core-yaml-8.
- **[low]** With `version: '1.1'`, `0o17` comes out unquoted and does not survive the round
  trip; the failure is loud — core-yaml-9.
- **[info]** For stage 5, locate through the `yaml` AST (source ranges) and edit the text
  at offsets, with a post-condition: this settles core-yaml-1, 2, 4, 7 and 8 at once —
  core-yaml-10.

### Agents & LLM

**[critical] The `answer` and `verdict` tools have no root `type: "object"`: `ask` and
`plan` fail at Anthropic** — `src/core/schemas/query.ts:38`, `src/agents/reviewer.ts:38`
Both schemas are `discriminatedUnion`s, serialised as `{ $schema, oneOf }`.
`@ai-sdk/anthropic` copies that schema verbatim into `input_schema`, whereas the API
requires `type: 'object'` and refuses `oneOf` at the root. OpenAI and Mistral accept it, as
the tapes show. No Anthropic tape exists. *Scenario:* with `IDP_PROVIDER=anthropic`, `ask`
exits 1 on `tools.3.custom.input_schema.type: Field required`. `plan` pays for the
Inspector and the Architect, then dies at the Reviewer. *Recommendation:* wrap
(`{ answer: <union> }`) or flatten, an architecture test
`z.toJSONSchema(spec.parameters).type === 'object'` for every tool, free validation
through `count_tokens`, then re-record. *Effort:* S · *Ids:* gap-provider-matrix-1
(rejection deduced from the official Anthropic SDK's type and from an emulation, not
observed live).

**[medium] A sterile turn is replayed as an empty assistant message** —
`src/llm/runtime.ts:67`
Anthropic receives `content: []`, which the API refuses. Mistral receives `content: ""`
without `tool_calls`, probably rejected. OpenAI drops the message. Triggers: a safety
refusal, or a pure-reasoning turn on Opus 5. *Recommendation:* do not emit an empty
assistant message. *Effort:* S · *Ids:* agents-llm-5, gap-provider-matrix-3.

**[medium] `finishReason` is ignored and no `maxOutputTokens` is set** —
`src/llm/runtime.ts:165`
A truncation (`length`, 4,096 tokens for an unknown model id or a gateway alias) produces
three identical retries, then "Name the value the gate could not accept". A refusal
(`content-filter`) produces a raw 400 error. *Recommendation:* typed `Truncated` and
`Refused` errors that are not retried, and an explicit, configurable `maxOutputTokens`.
*Effort:* M · *Ids:* gap-provider-matrix-2, agents-llm-11 (finishReason part).

**[medium] No context budget and no token counter** — `src/agents/inspector.ts:231`
`read_file` returns up to 64 KB per call and the transcript is resent whole on every turn.
`usage` is never read or recorded. A real `plan` makes 12 to 18 calls, with a theoretical
bound of about 117. *Recommendation:* truncate `read_file`, cap tool results per
transcript, a `usage` event with an end-of-run summary, a `--max-calls` cap, and Anthropic
prompt caching. *Effort:* M · *Ids:* agents-llm-2 (revised to medium: it is a constructed
worst case), product-gap-10.

**[medium] Provider layer with no configuration point** — `src/llm/providers.ts:23`
`createOpenAI()(model)` goes through the Responses API, so a `/chat/completions` gateway
(Ollama, LiteLLM, vLLM) can fail. Mistral has no `baseURL`. There is no Azure, no Bedrock,
no Vertex, and a single model serves the five agents although reviewer.ts justifies its
independence by decorrelation. *Recommendation:* an `openai-compatible` adapter
(`IDP_BASE_URL`), Azure and Bedrock entries, `IDP_MODEL_<AGENT>`, `timeout` and
`maxRetries`. *Effort:* M · *Ids:* agents-llm-4, architecture-8, product-gap-9 (gateways
part).

**[medium] The turn given back after a refused terminal call is not forced (Analyst,
Inspector, Architect)** — `src/agents/architect.ts:172`
`last = turn === maxTurns - 1`, whereas the Reviewer uses `>=`. After a repair, the last
turn goes out as `auto`, the model re-reads the catalogue and the draft ends without a
plan. *Recommendation:* `>=`, let the repair take precedence over `stop`, and extract the
common loop (see architecture-10). *Effort:* S · *Ids:* agents-llm-6.

**[medium] The `propose` tool's description asks for an empty list the schema refuses** —
`src/agents/tools/propose-tool.ts:112`
"Propose an empty list when the catalogue already declares everything" is at odds with
`.min(1)` and with the system prompt ("propose it ANYWAY"). Each refusal counts as a
sterile turn. *Recommendation:* align the description, fix the comment at line 34, and a
test that checks no description contradicts its schema. *Effort:* S · *Ids:*
agents-llm-7.

**[medium] Every new attempt starts from a blank transcript** — `src/agents/repair.ts:215`
The report says "in the plan you proposed", but the Architect sees neither that plan nor
its previous reads. It re-explores for up to 7 turns and may renumber its operations, which
makes the report wrong. *Recommendation:* attach the JSON of the refused operations to the
report, or keep the transcript. *Effort:* S · *Ids:* agents-llm-8.

**[medium] The bounded loop is copied four times and the copies already diverge** —
`src/agents/analyst.ts:91`
The Analyst and the Supervisor do not close the event stream on a provider failure, unlike
the other three agents. `answer` is delivered in the common batch, then filtered by name.
The "first Zod issue" computation exists in four copies. *Recommendation:* a generic
`runBoundedLoop({...})`, a `Tool = { spec, kind, run }` unit, and a single `reasonOf`.
*Effort:* M · *Ids:* architecture-10.

**[medium] The Supervisor fails on "Question." or "\*\*QUESTION\*\*"** —
`src/agents/supervisor.ts:39`
It compares by strict equality after `trim().toUpperCase()`. On a decorated output, it
answers exit 3 ("understood, will not be handled"), with a message shown twice and no
retry. *Recommendation:* a forced terminal tool `classify({kind})`, or failing that,
normalisation of the formatting, one retry, then exit 1 with a message that points to the
choice of model. *Effort:* S · *Ids:* gap-ask-grounding-7.

**[medium] The Analyst's witness guarantees that entities exist, not that they are relevant
or complete** — `src/agents/analyst.ts:212`
Anything a tool returned during the session serves as a witness. The model can therefore
cite unrelated entities, omit some, answer on the forced turn before the traversal is
over, or cite in the same turn a result it has not yet seen, and all of that exits 0. The
comment at lines 8-11 ("a refusal rather than a partial guess") is false.
*Recommendation:* the answer cites the call that produced it and the engine reprints that
result; "partial" for an answer given on the forced turn; only results from previous turns
serve as witnesses. *Effort:* M · *Ids:* gap-ask-grounding-2 (originally high, revised to
medium).

**[medium] The `nothing` outcome is refused as soon as a row has been read, and accepted on
an undeclared field** — `src/agents/analyst.ts:220`
"Does orders-api use billing-db-prod?" gives "the model contradicted what it read",
exit 3. "Which services in prod?" gives "No entity matches", although no Component
declares an environment. *Recommendation:* `nothing` tied to an empty call, an `unknown`
outcome for an undeclared field, exit 1 for an engine refusal. *Effort:* M · *Ids:*
gap-ask-grounding-3.

**[medium] `Answer` can only express entity refs** — `src/core/schemas/query.ts:38`
"Who owns X?" is refused, although the owner was in the row read, and the error message is
wrong. There is no yes/no, no count, no path. `answer:ready` emits `refs: []` for `nothing`
as for `unanswerable`, which the TUI will not be able to tell apart. *Recommendation:*
extend the union with `owners`, `holds`, `count` and `path`, verified by the engine, add
`outcome` to the event, and a tool for dangling references. *Effort:* M · *Ids:*
gap-ask-grounding-4.

**[medium] The Analyst's query surface does not hold at 300 services** —
`src/core/schemas/query.ts:8`
25 rows at most, no pagination, no system/lifecycle/tag filter, and a summary rounded to
"100+". *Recommendation:* `count` and `table` outcomes rendered by the engine, `offset`, and
relation tools once the read model is widened. *Effort:* M · *Ids:* product-gap-6
(originally high, revised to medium).

- **[low]** No maximum delay and no cancellation, implicit SDK retries (`maxRetries: 2`) —
  gap-provider-matrix-4, agents-llm-10 (see also the Architecture theme, session).
- **[low]** The transcript loses the reasoning and the `is_error` status of tool results —
  gap-provider-matrix-7.
- **[low]** `consumersOf` stops at the first Component although the description promises
  "any chain", there is no transitive descent, and `nameContains` is case-sensitive —
  gap-ask-grounding-5.
- **[low]** On MUTATION, `ask` prints "stage 5 writes" instead of suggesting
  `plan "<intent>" --repo`, and `plan` classifies nothing — gap-ask-grounding-8.
- **[low]** The truncation note accumulates over the whole session — gap-ask-grounding-11.
- **[low]** The injected summary enumerates the whole vocabulary without bound (about
  12,000 tokens per call at 1,500 teams) — gap-ask-grounding-12, domain-backstage-8 (prompt
  part).

### Backstage domain

**[high] A single pre-existing violation, anywhere, blocks every plan, and the intent route
pays for it three times** — `src/core/plan/recheck.ts:146`
The re-check runs `checkRepository(would)` over the whole repository, and both `plan` and
`repair` refuse on any error, attributing it to the plan ("violations in the repository
this plan would leave behind"). Since every non-hidden YAML file is read as an entity, a
`kind: Group`/`System`/`Location`, an `mkdocs.yml`, a `renovate.yaml`, a `.yaml` instead of
a `.yml` or an abbreviated owner is enough to block. On the intent route, the violation is
sent back to the Architect, which can do nothing about it: three paid calls, then exit 1.
*Scenario:* an employer points `plan --repo` at their catalogue and gets "No diff" for
every intent. *Recommendation:* a baseline before and after, refusal of only the violations
that are new or bear on the edited files, pre-existing ones shown as warnings and never
sent back to the Architect, unmodelled kinds and non-entity YAML reported without
blocking. *Effort:* S (the delta) to M · *Ids:* product-gap-2, core-plan-7, cli-ux-4,
domain-backstage-2, architecture-4, runtime-probe-6, core-yaml-11.

**[high] The read schema is much stricter than Backstage** — `src/core/schemas/entity.ts:8`
Only Component and Resource are accepted, with `apiVersion` v1alpha1, lowercase names
("invalid Backstage name" is false for `CheckoutService`), a closed `lifecycle`, an owner
and refs that must be qualified, and six Resource types. design.md:246 nevertheless claims
that `entitySchema` "READS a real Backstage catalogue". `backstage-http` will not be able to
reuse it. *Recommendation:* a tolerant read model (every kind as an opaque node,
abbreviated refs normalised with Backstage's defaults, free lifecycle and type flagged)
and the strict schema reserved for proposals; a conformance corpus drawn from Backstage's
examples. *Effort:* M to L · *Ids:* product-gap-3, runtime-probe-5, domain-backstage-1,
architecture-5 (kinds and types part).

**[medium] `metadata.namespace` is silently dropped and `:default/` is hard-coded in seven
places** — `src/context/graph/entity-graph.ts:16`
Two same-named entities in two namespaces become a blocking `duplicate-name`, a ref
`resource:payments/x` becomes dangling, and the graph merges distinct objects
(`consumersOf` can return the legacy service). *Recommendation:* `namespace` defaulting to
`default` in the schema, a single `refOf`/`parseRef` in `core/`, and an architecture rule
that forbids the `:default/` literal. *Effort:* M · *Ids:* domain-backstage-4,
product-gap-4, gap-ask-grounding-9, architecture-5 (namespace part), wip-diff-11 (refOf
part).

**[medium] The environment annotation `company.fr/env` is hard-coded and written into every
diff** — `src/core/schemas/vocabulary.ts:12`
On a catalogue that carries the environment elsewhere (a label, another annotation), the
environment policies fall silent, `graph --env` and `ask` see nothing, and every
declaration adds another company's domain key, visible to a recruiter.
*Recommendation:* `environmentAnnotation` in `.idp-agent.yml` with a neutral default
(`idp-agent.dev/environment`), injected into the vocabulary and the serialiser, and a
question rather than silence when the environment is unknown. *Effort:* S · *Ids:*
core-plan-8, domain-backstage-6, product-gap-5, architecture-5 (annotation part).

**[medium] Unmodelled Backstage fields are removed without a trace** —
`src/core/schemas/entity.ts:20`
`system`, `providesApis`/`consumesApis`, `subcomponentOf`, `title`, `labels`, `links` and
`relations` are precisely what answers questions about the SI's context.
*Recommendation:* `z.looseObject` on read, then model `system`, the APIs and `memberOf`,
with named directions in `EntityGraph`. *Effort:* M · *Ids:* domain-backstage-7.

**[medium] Type registry frozen at compile time** — `src/core/schemas/resource-types.ts:47`
`z.enum(RESOURCE_TYPE_NAMES)` is evaluated when the module loads, and `ResourceType` is a
literal union. The comment "nothing that consumes it needs to change" is therefore false:
a bucket or a topic cannot be declared without forking. *Recommendation:* factories
`makeEntitySchema(registry)`/`makePlanSchema(registry)`, a registry loaded from
`.idp-agent.yml`, and fix the comment. *Effort:* M · *Ids:* product-gap-8,
domain-backstage-9, architecture-5 (registry part).

- **[low]** `ContextProvider` is limited to `load()`, with no filter, pagination or signal;
  the two YAML readers already diverge — domain-backstage-8.
- **[low]** `show <name>` takes the first exact match when a Component and a Resource share
  a name, which contradicts the README; it stays latent as long as `show` reads only the
  fixture — runtime-probe-10, domain-backstage-10.
- **[info]** The `catalog-info` proposed by `init` has neither `github.com/project-slug`,
  nor `techdocs-ref`, nor `spec.system`; the engine could derive these annotations from a
  closed allow list — domain-backstage-11.

### `init` on real repositories

**[high] The 200-file budget is spent in alphabetical order: the manifest falls out** —
`src/context/project-fs/snapshot.ts:641`
A global sort by path, then `break` at the 201st file. An `app/`, `apps/`, `api/`, `docs/`
or `__generated__/` of more than 200 files evicts `package.json`, `go.mod`, `pom.xml` and
`catalog-info.yaml`, which are then neither read nor named, and `list_files` cannot show
them. `plan "<intent>"` uses the same snapshot. *Recommendation:* read the "signal files"
first, then the rest by depth; expose every candidate path to `list_files`; complete
`GENERATED_DIRECTORIES`; a non-regression test on a realistic tree. *Effort:* M · *Ids:*
gap-init-real-repos-1.

**[high] `init` stops on questions that cannot be answered** — `src/cli/index.ts:367`
`runInitRepo` does not receive `ask` and has no answer flag. The Inspector's prompt forbids
translating CODEOWNERS into an owner, and no common file states a lifecycle. Every
repository without a catalog-info therefore ends on exit 3 with "Fill them in and run this
again", and running it again asks exactly the same questions. The only nominal test uses
an Inspector that asserts what the files do not say. The stage 5 plan wires `ask` only for
`.idp-agent.yml`. *Recommendation:* `askOf(deps)` and `fillAnswers` as for `plan`,
`--owner`/`--lifecycle`/`--name`, the CODEOWNERS handle offered as a hint. *Effort:* M ·
*Ids:* gap-init-real-repos-2.

**[high] An existing `catalog-info` is not recognised: a duplicate, a twin file, or a
creation from /dev/null** — `src/cli/commands/init.ts:356`
`listDocumentNames` requires `---` and two spaces, and compares a name without its kind (an
API of the same name produces a false "already declared"). An existing `catalog-info.yml`
produces the proposal of a `.yaml` beside it. A file beyond the 200 cap gives
`before: undefined`, and `after` loses the existing documents. `FileEdit` does not say
which repository it writes to either. Stage 5 plans to move this function as it is.
*Recommendation:* decide through the parser and `refOf` (kind + name), read the `before`
directly and outside the budget, target an existing `.yml`, and a
`Change { repository, root, base, edits }`. *Effort:* M · *Ids:* core-yaml-4,
gap-init-real-repos-3, gap-stage5-readiness-8.

**[medium] The secret filter excludes ordinary manifests** —
`src/context/project-fs/snapshot.ts:97`
`"jsonwebtoken": "^9.0.2"`, `@octokit/auth-token`, `existingSecret: billing-db` and
`API_KEY=your-api-key` in a README are excluded with the reason "a secret is assigned a
literal value". The typical Node API loses its only manifest. *Recommendation:* recognise
version constraints as substitutions, a word boundary before `token`/`secret`, only
`KEY_MATERIAL` and `CREDENTIAL_MARKERS` for dependency manifests, and a regression table of
false positives. *Effort:* S · *Ids:* gap-init-real-repos-4.

**[medium] Monorepo: one Component per run, and targeting a sub-package loses the root's
context** — `src/agents/tools/project-tools.ts:70`
The root's CODEOWNERS and `.idp-agent.yml` are invisible from `--repo apps/web`, and an
`auth/` folder is excluded on its name alone. "One Component per run" is a deliberate
choice (§7.3), but nothing is documented. *Recommendation:* walk up to the git root for
CODEOWNERS and the configuration, document the monorepo strategy, and do not exclude
`auth/` on its name alone. *Effort:* M · *Ids:* gap-init-real-repos-7.

- **[low]** The closing line "The merge is what authorises it" does not say how to apply
  the diff (`idp-agent init | git apply` works), nor that `.idp-agent.yml` is not written —
  gap-init-real-repos-8.
- **[low]** `read_file` answers "no file at that path" for a file under an excluded folder
  or beyond the cap, does not normalise `./` or NFC, and decodes Latin-1 as U+FFFD —
  gap-init-real-repos-9.
- **[low]** §7.3 promises reading the "git remote", but nothing does it, and no source
  annotation is produced — gap-init-real-repos-10.

### CLI & UX

**[high] `ask`, `graph` and `show` read only the embedded fictional SI** —
`src/cli/index.ts:445`
`new FixtureProvider(deps.root ?? DEFAULT_ROOT)`, and `root` can be injected only by tests.
`ask --repo x` passes "--repo x" to the model as the question's text, `show --repo` looks
for an entity named "--repo", and `graph --repo` is refused. No output says that the data
is fictional. Yet `iac-fs` exists and already serves `plan`. `FixtureProvider` also reads
hidden files (the F6 fix was not carried over to it), which prevents reusing it as it is.
*Scenario:* a recruiter, with their own key, asks "which databases does the payment
service use?" and receives, on exit 0, the entities of the fictional tiger team.
*Recommendation:* `--repo <dir>` through `readRepository` for the three commands, a strict
`parseArgs` for `ask` and `show`, a "demo SI" banner on stderr, and the fixture only behind
`--demo`. Note: `iacRepo` is a URL, so it cannot serve as a local fallback. *Effort:* S ·
*Ids:* product-gap-1, agents-llm-3, cli-ux-3, domain-backstage-5, architecture-3,
build-ci-1, runtime-probe-7, gap-ask-grounding-1 (several verifications revised it to
medium because the limit is documented in the README; high kept in light of the goal).

**[medium] `validate` answers "0 violations" on exit 0 for a non-existent path, a file,
`--help` or an unreadable folder** — `src/cli/index.ts:391`,
`src/context/iac-fs/snapshot.ts:35`
`readdir(...).catch(() => undefined)`. `plan` has its `repositoryRoot`, but `validate`, the
CI barrier, does not. A subfolder under chmod 000 loses 11 entities with no error.
`PathEscapeError` is swallowed by a `catch {}` in rules.ts:118. The test
validate-command.test.ts:110 asserts the opposite of its title. *Recommendation:* reuse
`repositoryRoot` (exit 2), treat an unreadable subfolder as an error violation, and catch
in rules.ts only the "Component without a location" case. *Effort:* S · *Ids:* cli-ux-1,
runtime-probe-3.

**[medium] No non-interactive channel to answer** — `src/cli/index.ts:526`
The access level can be proven only through the prompt, and `askOf` returns `undefined`
outside a TTY. Every plan containing a grant therefore exits 3 in CI, with an instruction
that cannot be followed. `--json` does not imply non-interactive mode. *Recommendation:* a
repeatable `--answer <path>=<value>`, or `--answers file.json`, feeding `answered`, and a
message that quotes the exact flag. *Effort:* S · *Ids:* core-plan-11, cli-ux-5,
product-gap-11, runtime-probe-9 (channel part).

**[medium] Interactive prompt: allowed values never offered, an invalid answer is fatal,
Ctrl-C read as a refusal** — `src/cli/commands/plan.ts:711`
Answering "lecture" or "write" gives "Invalid input" and exit 1, with no new question, and
a paid run is lost. Ctrl-C gives exit 3 instead of 130. *Recommendation:*
`[read | readwrite]` in the question, a new question with the error (N attempts), exit 130
on interruption. *Effort:* M · *Ids:* cli-ux-6, runtime-probe-9 (prompt part).

**[medium] Raw Node stack traces and misclassified provider errors** —
`src/cli/index.ts:384`, `src/cli/index.ts:552`
`init platform` and `validate` do not go through `failed()` (ENOTDIR, EACCES, ENOENT, alias
bomb). A missing key, a 401, a 429 or an exceeded context exit 1, the code for "a gate
refused", with the SDK's raw message ("Pass it using the 'apiKey' parameter"). On `plan`,
that message is shown twice, after the Inspector has started. *Recommendation:* a single
try/catch in `main`, a key check in `chooseModel` (exit 2, a message naming
`ANTHROPIC_API_KEY`), and a distinct code for provider failures. *Effort:* S · *Ids:*
cli-ux-7, runtime-probe-8, agents-llm-11, runtime-probe-14, cli-ux-15.

**[medium] `init --repo <non-existent folder>` calls the model instead of exiting 2** —
`src/cli/index.ts:365`
Two calls or more are paid for a folder that does not exist, with a misleading message.
*Recommendation:* the `repositoryRoot` check before `readConfig`, and refusal of a snapshot
with no file at all. *Effort:* S · *Ids:* gap-init-real-repos-6, cli-ux-8.

**[medium] Unstable `--json` contract** — `src/cli/commands/plan.ts:746`
Two shapes depending on the route (no `outcome` on `--from`), neither the diff nor
`before/after`, no version, and prose on stdout when an answer is refused or when the
signature refuses. *Recommendation:* a `PlanReport` union discriminated by `outcome`,
versioned, carrying the edits, and emitted by every route, errors included. *Effort:* M ·
*Ids:* cli-ux-10, runtime-probe-15 (JSON part).

**[medium] Inconsistent argument parsing** — `src/cli/index.ts:63`
`-h`, `--version` and `version` give "unknown command", exit 2. `plan --help`,
`show --help`, `validate --help` and `ask --help` each behave differently, and the last one
goes to the model. Extra positionals are ignored. `init platform ""` writes into the
current directory. *Recommendation:* a central command → options table, global
`-h`/`--version`, refusal of extra positionals and of empty strings, a usage line rather
than the whole help. *Effort:* M · *Ids:* cli-ux-11, build-ci-12, runtime-probe-13.

- **[low]** `.idp-agent.yml`: `iacRepo` is required but never read, `backstage` is ignored,
  the lookup is limited to the exact cwd, and the file is not read by `plan --from` —
  cli-ux-13.
- **[low]** `MainDeps.cwd` is ignored by `plan --repo`/`--from` and `validate`, which will
  be a problem for an in-process TUI — runtime-probe-15.

### Architecture & extensibility

**[high] No session core for the intended chat: no router, no cancellation, no streaming,
no structured results** — `docs/design.md:923`, `src/cli/commands/result.ts:6`
The design reduces stage 7 to "Ink TUI" and excludes long sessions. Several building blocks
are missing:

- `CommandResult` carries only pre-formatted text (ANSI in the diff), and the `SignedPlan`
  is thrown away after rendering, whereas confirmation will need it;
- `LlmClient` has no `AbortSignal`, no stream, no `usage`;
- `ask` refuses a MUTATION instead of routing it to `plan`, and the bare intent (§7.4)
  gives "unknown command";
- the agents start again from a blank transcript, so there is no follow-up of the "and in
  dev?" kind;
- `Ask` can only ask questions about a path in the plan, not "submit / cancel";
- no multi-turn provenance rule is written down.

*Scenario:* at stage 7, plugging in Ink means re-parsing the text output or recasting
`plan.ts` (1,086 lines) and `LlmClient`, and by then stage 5 will have frozen a "one-shot
command" confirmation contract. *Recommendation:* a "Session and provenance" section in the
design before stage 5; separate computation (a structured `Preview`) from rendering;
`signal?` and `usage` in `GenerateRequest`/`GenerateResult` (a non-breaking addition); a
distinct `Confirm` seam; route through the Supervisor; validate first with a minimal
readline REPL. *Effort:* L · *Ids:* product-gap-13, architecture-9, cli-ux-12,
gap-stage5-readiness-13, agents-llm-10, gap-provider-matrix-4.

**[medium] The gate sequence is coded three times and the verdicts diverge** —
`src/cli/commands/plan.ts:740`
`repair.ts` runs the policies before the questions, `runPlan` does the reverse, and
`runInitRepo` runs neither the policies nor the re-check. The same plan gives exit 3 on
`--from` and exit 1 on the intent route. `--from` goes neither through the Reviewer (that
is intended) nor through `.idp-agent.yml`, although the brief claims that "every plan
crosses the five gates". `contextsOf` is private to `cli/`. *Recommendation:* a pure
`evaluatePlan()` engine in `core/plan/pipeline.ts`, called by the three routes and the
future TUI; `contextsOf` moved out of `cli/`; a parity test; decide whether `--submit` is
allowed on `--from`. *Effort:* M · *Ids:* architecture-1, gap-stage5-readiness-10,
core-plan-14.

**[medium] The `Operation` union is not an extension point** —
`src/core/plan/policies.ts:332`
There is no exhaustive `switch` anywhere. A fourth operation compiles, escapes the
policies and receives an invented reason in `dropped`. `edits.ts:199` calls
`appendSequenceItem` without testing `patch.patch`, so a `remove-dependency-of` would be
applied as an addition. It is the same class of bug as `update-entity` without a gate.
*Recommendation:* a `HANDLERS: { [K in Operation['op']]: OperationHandler }` table checked
by the compiler, or `_exhaustive: never` at each of the eleven sites. *Effort:* M ·
*Ids:* architecture-6, core-plan-10.

**[medium] No plugin story** — `src/core/plan/policies.ts:213`
Policies and rules are closed unions in a single function, there is no `name → factory`
table for providers, and `package.json` has no `exports`. Every planned module (a cyber
rule, backstage-http, a GitLab forge) touches the core. *Recommendation:* `Policy`/`Rule`
interfaces as objects in an array, enabled per repository; factory tables for
`ContextProvider` and the models; `exports: './plugin'` at publication. *Effort:* M ·
*Ids:* architecture-7 (partly a judgement).

**[medium] The architecture rules can pass on empty and do not cover `cli/`** —
`tests/architecture/dependencies.test.ts:13`
`readdir(...).catch(() => [])` and `readFile(...).catch(() => '')` mean the 13 rules stay
green if a folder is renamed. `.mts` files are ignored. A single rule walks the transitive
closure, and none restricts who writes outside `scaffold/`. `cli/commands/plan.ts` and
`cli/config.ts` read the repositories. AGENTS.md, SECURITY.md and the brief overgeneralise.
*Recommendation:* `expect(files.length).toBeGreaterThan(40)`, fail on an unresolved
import, scan `.mts`/`.cts`, a rule "only `forge/**` and `scaffold/write.ts` write or call
git", and a rule "`forge/` is never reachable from `core/`/`agents/`/`context/`".
*Effort:* S · *Ids:* architecture-11, gap-stage5-readiness-9, tests-12.

### Stage 5 readiness (writing)

**[medium] The preview is computed on the working tree, ignored files and uncommitted
changes included** — `src/context/iac-fs/snapshot.ts:32`
If stage 5 commits `after` from HEAD, it carries the file's local changes, which did not
appear in the preview. A file ignored by git can get a plan refused or make it pass for
already declared. *Recommendation:* decide that the base is a commit
(`git show <base>:<path>`), build the commit through plumbing without touching the tree,
and define the contracts for no git / detached HEAD / remote ≠ `iacRepo`. *Effort:* L ·
*Ids:* gap-stage5-readiness-3 (revised to medium: it is a design decision still open).

**[medium] No compare-and-swap, and the snapshot and the bytes are read on either side of
the Inspector call** — `src/cli/commands/plan.ts:896`
`FileEdit.before` is consumed only by rendering. The comment at `repair.ts:417` describes
the reverse of the order in the code. *Recommendation:* a single read
`{path, bytes, sha256, entities}` shared by the gates and `planEdits`, a re-read and
comparison at write time, `update-ref <new> <old>` in git mode. *Effort:* M · *Ids:*
gap-stage5-readiness-6.

- **[low]** `FileIO.writeNew` can neither modify, nor delete, nor sync to disk (fsync), and
  loses the `written` list on failure: it is not a reusable base — gap-stage5-readiness-7.
- **[low]** No plan identity to name branches; §4.3 ("never the same file") is false for
  two consumer additions to one grant — gap-stage5-readiness-12.

### Tests

**[medium] The invariant generators never produce the shapes that break the surgery** —
`tests/invariants/arbitraries.ts:116`
Always `---`, two spaces, LF, no BOM, no trailing comment. "Byte for byte" is proven only
on already-normalised files, and stage 5's idempotence invariant would hold for a writer
that writes nothing. *Recommendation:* vary each of these dimensions independently, and an
*effectiveness* property: the requested effect is present after application, or else the
operation is in `dropped` with a reason. *Effort:* M · *Ids:* core-yaml-6,
gap-stage5-readiness-11.

**[medium] The scenarios pin neither the outcome nor the diff** —
`tests/scenarios/plan-mode.test.ts:157`
`endedWell` accepts 0, 1 or 3. A `read → readwrite` mutation of the diff rendering leaves
the 790 tests green. `link-db-missing` ends on exit 3 on the question `d63edcb` was meant
to remove, and the test stays green. Since replay is deterministic, the outcome can be
pinned. *Recommendation:* record the expected outcome with the tape and assert it on
replay, plus a golden test of the complete diff for a creation and for an
`add-dependency-of`. *Effort:* M · *Ids:* tests-2, wip-diff-7.

**[medium] The two properties on `signPlan` are 95% empty** —
`tests/invariants/core.test.ts:124`
A silent `return` when the schema refuses, and `arbitraryPlan` produces no valid grant.
The coverage test samples before the filter. *Recommendation:* plans valid by
construction (grants, Component, update), `fc.pre`, and coverage measured on accepted
plans. *Effort:* S · *Ids:* tests-3.

**[medium] The recording harness merges, freezes the wrong thing, and does not fingerprint
what is sent** — `src/llm/recording.ts:58`

- In record mode, tapes merge: there are 16 dead turns, 9 of the 18 in
  `link-already-declared` among them.
- `call.transcript` is stored by reference, so every turn shows the final transcript.
- `usage` is never written.
- The digest hashes Zod's internal representation, blind to `min`, `max`, `regex` and
  `describe`.
- The forced-turn fallback records a fingerprint the replay never recomputes.
- `question-mode` has no freshness guard, and `mutation-classified-link` replays another
  sentence.

F7 is wrongly marked "closed". *Recommendation:* start from an empty tape in record mode,
`structuredClone` at call time, a digest over `z.toJSONSchema` + `toolChoice`, check that
every turn was consumed, a shared guard, re-record, reopen F7. *Effort:* M · *Ids:*
agents-llm-9, tests-4, tests-5, tests-6, wip-diff-12.

**[medium] Any prompt change turns CI red until a paid re-recording, and nothing explains
it** — `tests/scenarios/plan-mode.test.ts:138`
The freshness assertion is inside `run()`, so a stale tape masks the invariants
(repository untouched, exit). Record mode re-calls every turn, 42 instead of 3. §9.3 and
recording.ts describe the opposite policy. CONTRIBUTING says nothing about it.
*Recommendation:* freshness in a separate test or `expect.soft`, a "record-stale" mode
from the first diverging turn, a `tests/README.md` on the tape lifecycle, a freshness CI
job reserved for maintainers. *Effort:* M · *Ids:* tests-9, wip-diff-6.

**[medium] The live path, the adapters and each provider are never tested** —
`tests/unit/runtime.test.ts:130`
The assistant and tool-result turns of `toMessages`, the response mapping, the record
write and the anthropic/openai adapters are never exercised. No Anthropic tape, and
Mistral has never been recorded in plan mode. A complete offline bench runs in under
0.5 s. *Recommendation:* `tests/contract/providers.test.ts` with a mocked fetch or
`MockLanguageModelV4`, checking the HTTP bodies (object root, non-empty messages, id
pairing, `tool_choice`). *Effort:* M · *Ids:* tests-10, gap-provider-matrix-5.

**[medium] The `docs/audit-attacks` oracle counts crashes as closed defects** —
`docs/audit-attacks/turn-usage.test.ts:40`
`turn-usage` and `schema-drift` point to `docs/recordings`, which does not exist, and
crash on ENOENT. `plan-outcomes` has no `expect`. Test A "Reviewer opening" crashes on
`input.targets`. Test G "init … vouches" signs with `wordsOf: 'user'` and so does not
exercise the init path. *Recommendation:* the path `../../tests/recordings`, failure by
assertion only, a sentinel that tells "crashed" from "closed", and update the table.
*Effort:* S · *Ids:* tests-11, core-plan-13 (oracle part), docs-10 (test G part).

**[medium] The suite depends on the contributor's shell** —
`tests/unit/init-command.test.ts:24`
Exported `IDP_PROVIDER`/`IDP_MODEL` (as the README asks) make two tests fail, and in record
mode these tests would be recorded into `init.json`. *Recommendation:* a setupFile that
neutralises `IDP_*` and `*_API_KEY`, a `testDeps()` factory, and a record mode reserved
for scenarios. *Effort:* S · *Ids:* tests-8.

- **[low]** The offline guard covers only `globalThis.fetch` (http, net, undici and
  WebSocket get through), and the adapters read the key from `process.env` — tests-7.
- **[low]** About 178 temporary folders left behind on every run, and a 10-minute timeout
  even in replay — tests-13.
- **[low]** Question mode has only four tapes, all from the same model, and
  `toContain('billing-api')` accepts a wrong answer — gap-ask-grounding-13.
- **[info]** Some tests pin the wording of the Reviewer's prompt: a defensible contract,
  but not a measurement of behaviour; plan a small evaluation set outside CI — tests-14.

### Docs & credibility

**[medium] `SECURITY.md` still describes stage 1** — `SECURITY.md:6`
"No model, no network call, no write path". "No secret reaches the model" is filed under
"not yet built". `__proto__` is said to be "dropped" whereas it is refused. "Stripped" and
"cannot widen permissions" are contradicted by the code, and nothing says what goes to the
provider. It is the first document a CISO will read. *Recommendation:* a stage 4 header, a
"what leaves your machine" table (request, summary, files read, caps, retention per
provider), the tested guarantees with their test, and the known limits. *Effort:* S ·
*Ids:* docs-3, security-9 (originally high for docs-3, revised to medium: it is
documentation).

**[medium] The demo and the examples promise a diff the binary does not produce** —
`examples/README.md:14`, `scripts/demo.sh:23`
`add-access.json` is announced as exit 0 whereas it exits 3, the same file says so further
down, and "three examples" actually counts four files. `pnpm demo` dies at step 2 under
`set -euo pipefail` and never shows the hash proof. The script is in French and does an
unguarded `rm -rf "$1"`. No CI runs it. *Recommendation:* `declare-database.json` at step
2, add-access presented as "the level is always asked", a corrected table, `mktemp -d`, the
demo run in `smoke`. *Effort:* S · *Ids:* docs-1, build-ci-4, product-gap-12,
runtime-probe-9 (doc part).

**[medium] No "try it on your own repository, with your own key" path** — `README.md:62`
No key variable is named, no tested model is cited, there is no `.env.example` (although
`.gitignore` provides for one), and the `credentials.json` promised by §7.0 does not exist.
The declarations repository's contract does not appear in the README, nor does
`.idp-agent.yml`, and nothing explains how to wire the repository into Backstage.
*Recommendation:* an honest "Try it on your own" section, a provider → variable → recorded
model → limits table, `docs/repository-contract.md`, a "Wire it into Backstage" excerpt.
*Effort:* M · *Ids:* docs-2, build-ci-11, cli-ux-15, product-gap-9 (doc part).

**[medium] Wrong test counts, stage status and design status, and stale internal
documentation** — `AGENTS.md:58`
685 in the README, 748 in AGENTS.md, 790 in reality. "Stage 4… none on main", which is
false. design.md stays "approved, ready for implementation planning". `withAnswers` is
cited in AGENTS.md:254, cli/README.md:39, derive.ts:68 and plan.ts, with an orphan JSDoc
block. The gate order is wrong in AGENTS.md:190 and in `repair.ts`. "Four ship" for five
policies. §10 puts git in `core/`, which the architecture rule forbids. `catalog-info.yml`
in the docs, `.yaml` in the code. "GitLab: the interface is in place". *Recommendation:*
remove the hard-coded counts, or check them in `smoke`; mark `[built]`/`[stage N]` per
design section; fix the orphan references; a lint of the symbols cited in backticks.
*Effort:* S · *Ids:* docs-4, cli-ux-14, architecture-12, core-plan-13, wip-diff-11,
gap-stage5-readiness-14.

**[medium] The README's first screen says neither "Backstage", nor what you type, nor what
you get** — `README.md:6`
The first gesture offered is `pnpm test`. "Platform GitOps is the application domain, not
the subject" contradicts the goal. "No API key" is false for `ask`/`plan`.
*Recommendation:* a one-line pitch, a real intent → diff example (captured from a tape),
"what works today / next", a 60-second keyless try. *Effort:* S · *Ids:* docs-5 (partly a
judgement).

**[medium] No keyless demonstration of the multi-agent loop** — `src/cli/index.ts:617`
Nine real tapes exist, but replay is reachable only through injection in tests. The
guided tour of §7.1 is planned nowhere. *Recommendation:* `idp-agent tour`, which replays 2
or 3 packaged tapes while announcing "replaying", plus an asciinema drawn from that tour,
placed at the top of the README. *Effort:* M · *Ids:* docs-6.

**[medium] Nothing says that the tool provisions nothing** — `src/cli/commands/plan.ts:60`,
`README.md:106`
"Nothing is provisioned yet" suggests that provisioning is coming, and no reconciler,
input contract or example is provided. *Recommendation:* a "What it produces — and what it
doesn't" section, a three-box diagram, and an `examples/reconciler/` in plan mode
(Terraform or Crossplane). *Effort:* M · *Ids:* docs-7, product-gap-7.

**[medium] The vision (chat, real SI, plugins) is absent from the roadmap, and there is no
extension guide** — `README.md:121`
*Recommendation:* a roadmap from the user's point of view, `docs/extending.md` (LLM
provider, resource type, `ContextProvider`, forge), and a "session model" ADR before
stage 7. *Effort:* M · *Ids:* docs-8.

- **[low]** The folder READMEs contradict the code: Reviewer "nothing else", `write.ts` the
  only fs module, cli/README at stage 1, core/README without `plan/` — docs-9.
- **[low]** Audit report: `c1bb7d8` not publicly reachable, "this branch" frozen, `rtk`
  instructions — docs-10.
- **[info]** The dense, aphoristic prose is a strength in the ADRs and a drag in the
  README, AGENTS.md and commit subjects (72% comments relative to code) — docs-11.
- **[info]** About 7,000 lines of "For agentic workers" plans on display: own the method in
  the README ("How this was built") and move these plans under `docs/process/` — docs-12.

### Build & CI

**[medium] `pnpm smoke` runs the repository's `dist/`, not the tarball** —
`scripts/smoke.mjs:200`
Removing `fixtures` from `files` leaves smoke green. Only two template files are checked
in the package. *Recommendation:* `npm pack`, extraction, and running
`package/dist/cli/bin.js` from an outside cwd. *Effort:* S · *Ids:* build-ci-2.

**[medium] `dist/` is never cleaned and there is no `prepack`: `__before_probe.js` is in
the tarball** — `package.json:44`
66 `.d.ts` files with no `exports`, and rc.1 was published by hand. *Recommendation:*
`rm -rf dist` in `build`, `prepack`/`prepublishOnly` (typecheck, test, smoke), publication
from CI with `--provenance`, and a decision on `declaration`/`exports`. *Effort:* S ·
*Ids:* build-ci-3.

- **[low]** The burned version `0.1.0-rc.1` is still in place and injected into the
  generated workflows; no CHANGELOG and no tags — build-ci-5.
- **[low]** The npm name `idp-agent` is fully unpublished and the README has not reserved
  it; a takeover by a third party is plausible but not demonstrated — build-ci-6.
- **[low]** CI without `permissions`, `concurrency` or `timeout-minutes`, Linux only;
  Windows poorly served by `path.normalize` in `resolveEntityPath`; demo and attacks never
  run — build-ci-8, product-gap-14.
- **[low]** Implicit dependency policy (exact pins and carets mixed, no `packageManager` and
  no Dependabot, `engines` wider than what vitest supports) — build-ci-9.
- **[low]** Neither linter nor formatter — build-ci-10.

### Recent changes (formerly work in progress, now committed)

**[high] The Reviewer vetoes the §7.5 "missing resource" branch that `created()` was meant
to unblock** — `src/agents/reviewer.ts:100`
The SYSTEM prompt lists "touches an entity the request never mentioned" among the
rejections. The Reviewer never receives the fact "`resource:default/orders-db` resolves
nowhere". The `link-db-missing` tape shows that refusal, then an Architect that removes the
database, and an ending on exit 3 on `resource:prod/orders-db`. The commit message
attributes this behaviour to "a fuller vocabulary", which the tape contradicts.
*Scenario:* the employer asks for access to a database that is not yet in the catalogue,
one of the first things they will try. *Recommendation:* a per-reference resolution fact,
a §7.5 sentence in the SYSTEM prompt, a re-recording, and an assertion of the expected
outcome. *Effort:* M · *Ids:* wip-diff-3.

**[medium] `created()` lets an operation vouch for itself** — `src/core/plan/sign.ts:344`
A grant whose `dependsOn` points to itself signs `derived` and passes the four free gates,
whereas it was `novel` at `1dc8cc2`. *Recommendation:* exclude the current operation,
count only the creations that will get a path, and a policy "a grant's `dependsOn`
designates an object". *Effort:* S · *Ids:* wip-diff-1 (originally high, revised to
medium).

**[medium] `created()` vouches for Components that `planEdits` discards** —
`src/core/plan/sign.ts:219`
The grant is written, the Component exists neither in the catalogue nor in the diff:
"both are in one diff" is false. *Recommendation:* restrict `created` to the Resources
that will receive a path. *Effort:* S · *Ids:* wip-diff-4.

**[medium] `effectsOf` says "would be written" for an update that changes no byte** —
`src/agents/repair.ts:561`
This message contradicts the `targets` section of the same prompt. The `moved` branch is
unreachable. *Recommendation:* compute the effect from the bytes or from a real
`already-declared` outcome (see priority 8). *Effort:* S · *Ids:* wip-diff-2 (originally
high, revised to medium).

- **[low]** The Reviewer's SYSTEM prompt still says "That is everything" and does not
  introduce the new sections — wip-diff-5.
- **[low]** The `...facts` spread and the double typing `ReviewFacts`/`ReviewInput` let a
  fact disappear silently — wip-diff-8.
- **[low]** The new tests cover the nominal path, but not self-reference, the update with
  no effect, or the discarded Component — wip-diff-10.

## 4. What is solid

- **A structural trust boundary.** Closed `Operation` union, `strictObject` everywhere, no
  path and no annotation the model can propose, engine-computed paths, `SignedPlan` frozen
  with an unexported brand. `{unknown}` becomes a question rather than a guess, and the
  access level is a classified field, hence independent of the language.
- **A pure, testable core.** `planEdits` takes bytes and returns
  `FileEdit {path, before, after}`. The same computation feeds the diff, the virtual
  re-check and, tomorrow, the write, and `before` is already the compare-and-swap token.
  The unified diff was validated by 368 random `git apply` runs, without a single failure.
- **"Writes nothing" proven, not asserted.** The trees are hashed before and after every
  run of `plan`, `ask`, `init` and `validate`, and `init platform` is idempotent
  (`kept 12`).
- **An exemplary keyless harness.** 790 offline tests in about 2 s, stable across 5 shuffle
  seeds. The `MainDeps.client`/`ask`/`events` seams let the whole Inspector → Architect →
  Reviewer chain be driven with scripted clients. This entire review was conducted that
  way.
- **Careful output and read guards where they exist.** project-fs does `realpath` then
  `lstat`, refuses hard links, reads with `O_NOFOLLOW` and bounded reads, and catches 67
  attacks out of 68. `plain()` is correct on CSI, OSC, DCS and C1. The forced-turn fallback
  works on all three providers.
- **A correct and fast `EntityGraph`.** It matches a brute-force oracle on si-demo,
  withstands cycles and diamonds, and builds 50,000 entities in 21 ms. `validate` goes
  through 1,500 entities in 0.28 s.
- **A visible engineering culture.** Seven short ADRs, "What this does NOT cover"
  sections, an adversarial audit kept as executable tests, consistent 0/1/2/3 exit codes
  checked by `smoke`, pinned and consistent AI dependencies, and TypeScript that is
  genuinely strict.

## 5. Roadmap for the foundation

**This week**

1. An object root for `answer` and `verdict`, an architecture test on tool schemas, a first
   provider contract test (gap-provider-matrix-1, -5).
2. `SurgeryError` on a missing target or `spec:`, a single YAML reader that rejects
   `document.errors`, a per-file try/catch (priority 2).
3. `--repo` for `ask`, `graph` and `show`, a "demo SI" banner (priority 3).
4. A single provenance for `deriveOwners`, the policies and `signPlan`, with the two
   regression tests (priority 5).
5. The quick wins of section 6, in particular the rewrite of `SECURITY.md` and the demo.

**Before stage 5**

1. A before/after violation delta in the re-check, never sent back to the Architect,
   foreign kinds and YAML reported without blocking (priority 4).
2. A tolerant read model faithful to Backstage, `namespace` and a single `refOf`, a
   configurable `environmentAnnotation`, an injectable type registry (schema factories).
3. Hardened environment gates, a complete `restates`, a real `already-declared` outcome
   for updates (priorities 6 and 8).
4. Surgery located through the `yaml` AST, with a systematic post-condition. Widened
   invariant generators and an effectiveness property.
5. A single `evaluatePlan()` engine for the three routes; an exhaustive `switch` or a
   handler table on `Operation`.
6. Written decisions: the base is a commit, not the working tree; `ApprovedChange` issued
   after the five gates; `Change { repository, base, edits }`; shared physical confinement
   (lstat → realpath → `O_NOFOLLOW`); architecture rules "only `forge/` writes".
7. A "Session and provenance" design section, a `Confirm` seam, computation separated from
   rendering, `signal?` and `usage` in `LlmClient`, before the confirmation contract is
   frozen.

**Before publishing**

1. A usable `init`: signal files first, `ask` and flags wired, an existing `catalog-info`
   detected through the parser (priority 9).
2. A fixed secret filter (every match, new prefixes, `git ls-files`, no false positives)
   and a guard on the current directory.
3. A reliable recording harness (empty tape in record mode, digest over the JSON Schema,
   expected outcome asserted, freshness separate), one Anthropic tape and one Mistral tape
   in plan mode, the audit oracle repaired.
4. A keyless `idp-agent tour` and an asciinema, the README's first screen and "Try it on
   your own", `docs/extending.md`, `docs/repository-contract.md`, a reconciler example.
5. Packaging: smoke on the tarball, `prepack`, CI publication with provenance, version
   rc.2, the npm name reserved (or scoped), macOS and Windows CI, lint.

## 6. Quick wins

- Wrap `answerSchema` and `verdictSchema` in an object and add the `type === 'object'` test
  (gap-provider-matrix-1).
- `plain()` on `ask.ts:35` and `ask.ts:54`, and `paintDiff(plain(diff))` (security-4,
  cli-ux-9).
- `validate`: reuse `repositoryRoot`, exit 2 on a non-existent path; the same check at the
  start of `runInitRepo` (cli-ux-1, gap-init-real-repos-6).
- `appendSequenceItem`: `throw new SurgeryError` in place of the two `return text`
  (gap-stage5-readiness-1).
- An `invalid-entity` rejection when `document.errors.length > 0` in the three readers
  (core-yaml-3).
- The regex `sk-[A-Za-z0-9_-]{20,}` and `matchAll` in the assignment rule (security-1,
  security-2).
- Version constraints (`^9.0.2`) recognised in `SUBSTITUTED` (gap-init-real-repos-4).
- `chooseModel` checks the key variable and exits 2 with "export ANTHROPIC_API_KEY=…"
  (runtime-probe-14).
- Global `--version`, `-h` and `version` (build-ci-12).
- An `ask` MUTATION message that suggests `idp-agent plan "<intent>" --repo <dir>`
  (gap-ask-grounding-8).
- Align `propose`'s description with the schema (agents-llm-7), and
  `turn >= maxTurns - 1` in the three loops (agents-llm-6).
- Normalise the Supervisor's output (punctuation, `**`, backticks) (gap-ask-grounding-7).
- Do not emit an empty assistant message in `toMessages` (gap-provider-matrix-3).
- `providerOptions: { openai: { store: false } }` (gap-provider-matrix-6).
- `demo.sh`: `declare-database.json` at step 2 and `mktemp -d`; fix the table in
  `examples/README.md` (docs-1).
- A stage 4 header in `SECURITY.md`; the key variable names and a `.env.example` in the
  README (docs-3, docs-2).
- Remove the hard-coded test counts; replace the mentions of `withAnswers`; remove the
  orphan JSDoc; "Five ship" (docs-4).
- The path `../../tests/recordings` in the three attack tests (tests-11).
- `rm -rf dist` in `build`, plus `prepack`; version `0.1.0-rc.2` (build-ci-3, build-ci-5).
- `permissions: contents: read` and `persist-credentials: false` in the generated
  `validate.yml` and in `ci.yml` (build-ci-7, build-ci-8).
- `iacRepo` optional in `.idp-agent.yml` as long as it is not read (cli-ux-13).
- `expect(files.length).toBeGreaterThan(40)` in the architecture rules (architecture-11).

## 7. Findings set aside

No finding was refuted by the counter-verification. For transparency, these are the
claims judged inaccurate or overstated inside findings that were kept:

- **security-6** and **security-5**: these are documented design choices, not bugs. They
  are kept at low and medium, for the overly strong sentence in `SECURITY.md` and as
  hardening.
- **gap-stage5-readiness-5**: a TypeScript brand that `as unknown as` gets around is not a
  defect in itself. Only the "issued at gate [2]" point is kept.
- **agents-llm-10** and **gap-provider-matrix-4**: "blocks the TUI" is overstated, since
  `signal?` is a non-breaking addition. The "streaming required > 21,333 tokens" limit is a
  guard of the official SDK, which this project does not use.
- **build-ci-6**: a takeover of the npm name by a third party after unpublishing was not
  demonstrated from npm's policy.
- **runtime-probe-9**: the stale comments it cites (AGENTS.md:235, plan.ts:269) cannot be
  found in the current tree.
- **architecture-6** and **core-plan-10**: AGENTS.md does not require the `switch`, only
  its exhaustiveness when there is one, and a new operation does not reach the bytes (it
  ends up in `dropped`).
- **architecture-9**: "changing the tapes of 790 tests" is overstated.
- **tests-9**: a contributor can re-record with their own key, not only with the owner's.
- **tests-10**: `generateText` and `toMessages` are exercised on a `user` transcript by
  main.test.ts:119.
- **docs-7**: the absence of a delete operation is documented (README.md:119,
  SECURITY.md:86).
- **docs-8**: the `ContextProvider` contract is documented in ADR-0003.
- **docs-9**: cli/README does describe `plan`, in its "Asking" section.
- **product-gap-6** and **product-gap-10**: the figures "300 services" and "about a hundred
  calls" come from theoretical bounds, not from measurements.
- **Test count**: the baseline gave 772 (HEAD `1dc8cc2`) and 780 (with the work in
  progress). The 790 several verifiers cite is the current HEAD, `eee67d6`.

---

## Index of findings

One row per finding, 212 in all, grouped by the dimension that raised it. Severity is the
final one, after verification; the verdict is the adversarial verifier's. Where section 3
merged several findings, each keeps its own row here.

### Core — YAML surgery and serialisation

| id | severity | verdict | location | title |
|---|---|---|---|---|
| core-yaml-1 | high | confirmed | `src/core/yaml/surgery.ts:39` | `appendSequenceItem` silently does nothing on common valid YAML files: "nothing to change", exit 0, access not granted |
| core-yaml-2 | high | confirmed | `src/core/yaml/surgery.ts:166` | The surgery writes a second `dependencyOf:` key when it does not recognise the existing one: invalid YAML, exit 0 |
| core-yaml-3 | high | confirmed | `src/core/yaml/serialize.ts:93` | `parseDocuments` (and `readOne` in iac-fs) ignore `document.errors`: broken YAML accepted, values silently lost |
| core-yaml-4 | high | confirmed | `src/cli/commands/init.ts:346` | `init --repo`: name-only identity gives a duplicate on a catalog-info.yaml without `---`, and a false "already declared" against a same-named API |
| core-yaml-5 | medium | confirmed | `src/core/paths/entity-path.ts:73` | `assertInsideRepo` checks lexically only: a symlinked folder makes writes land outside the repository (already true of `init platform`, blocking for stage 5) |
| core-yaml-6 | medium | confirmed | `tests/invariants/arbitraries.ts:108` | The invariant tests never generate the shapes that break: "byte-for-byte" is proven only on already-normalised files |
| core-yaml-7 | low | confirmed | `src/core/yaml/surgery.ts:278` | CRLF files: the appended line and the inserted document are LF, hence mixed line endings |
| core-yaml-8 | low | confirmed | `src/core/yaml/surgery.ts:264` | A consumer already present but followed by a comment is added a second time, and the preview shows it as a new authorisation |
| core-yaml-9 | low | confirmed | `src/core/yaml/serialize.ts:29` | `version: '1.1'` leaves YAML 1.2-only numerals (`0o17`) unquoted: a valid name does not survive the round trip |
| core-yaml-10 | info | confirmed | `src/core/yaml/surgery.ts:36` | Judgement for stage 5: locate with the parser's AST and edit the text at offsets, with a post-condition, rather than with regexes |
| core-yaml-11 | medium | confirmed | `src/core/schemas/entity.ts:111` | (Outside the dimension, found testing real files) A single entity of another kind in the repository blocks every plan |

### Core — plan, policies and signature

| id | severity | verdict | location | title |
|---|---|---|---|---|
| core-plan-1 | high | confirmed | `src/core/plan/policies.ts:361` | cross-environment-consumer counts the NAME's segments as a scope: a dev access named "…-prod" can target the prod database |
| core-plan-2 | high | confirmed | `src/core/plan/derive.ts:184` | The user's answers are no longer visible to deriveOwners or the policies: an owner cannot be settled, an answered environment is ignored |
| core-plan-3 | high | confirmed | `src/core/plan/policies.ts:249` | update-entity: the environment of the extended grant is never asked when the request names none |
| core-plan-4 | medium | confirmed | `src/core/plan/echoes.ts:35` | `echoes` reads "non-prod", "pre-prod", "hors-prod" as a request for prod |
| core-plan-5 | medium | confirmed | `src/core/plan/grant.ts:97` | "Already declared" compares only the level: "the repository already says it" for a grant that lacks the requested consumer |
| core-plan-6 | high | confirmed | `src/core/plan/edits.ts:199` | An update-entity on a 4-space-indented file (or a commented `name:`) does nothing and prints "nothing to change." on exit 0 |
| core-plan-7 | high | confirmed | `src/core/plan/recheck.ts:146` | The re-check refuses every plan as soon as a PRE-EXISTING violation exists anywhere (and entitySchema rejects common Backstage kinds) |
| core-plan-8 | medium | confirmed | `src/core/schemas/vocabulary.ts:12` | Hard-coded environment annotation `company.fr/env`: environment policies silent on a real repository, a foreign annotation written into its files |
| core-plan-9 | medium | confirmed | `src/core/plan/sign.ts:83` | The SignedPlan brand can be forged by spread/structuredClone, and the seal on the Maps can be bypassed |
| core-plan-10 | low | partial | `src/core/plan/policies.ts:332` | No exhaustive dispatch on Operation/Patch: the next operation will cross the gates unchecked |
| core-plan-11 | medium | confirmed | `src/core/plan/sign.ts:311` | `plan --from` cannot produce a grant diff outside a terminal: the level can be proven only through a prompt |
| core-plan-12 | low | confirmed | `src/core/plan/recheck.ts:64` | recheck and edits diverge on "already declared" (duplicates, updates, non-exhaustive outcomes) |
| core-plan-13 | low | partial | `AGENTS.md:254` | Documentation and audit oracle out of sync (withAnswers, policy count, attack tests that crash) |
| core-plan-14 | info | confirmed | `src/cli/commands/plan.ts:712` | Pipeline readability: two diverging orchestrations, an ambiguous provenance taxonomy, a narrative comment that ages |

### Security

| id | severity | verdict | location | title |
|---|---|---|---|---|
| security-1 | high | confirmed | `src/context/project-fs/snapshot.ts:704` | project-fs: a single placeholder before a literal secret lets the whole file through |
| security-2 | high | confirmed | `src/context/project-fs/snapshot.ts:128` | project-fs: the deny list misses the most common key formats, including those of the providers the tool uses |
| security-3 | medium | partial | `src/cli/index.ts:436` | The current directory is sent to the model with no guard or consent: run from ~, that is personal data |
| security-4 | medium | confirmed | `src/cli/commands/ask.ts:54` | Escape sequences are filtered site by site only: `ask`'s model text and repository content reach the terminal raw |
| security-5 | low | partial | `src/cli/commands/init.ts:135` | init: what the Inspector reports is validated without any file saying it, owner included |
| security-6 | low | partial | `src/core/plan/policies.ts:35` | No deterministic rule links an operation to the request: an unrequested grant passes every deterministic check |
| security-7 | medium | confirmed | `src/context/iac-fs/snapshot.ts:74` | iac-fs ignores YAML errors: a duplicate key passes `validate`, and a single unreadable file crashes the command |
| security-8 | medium | confirmed | `src/core/paths/entity-path.ts:76` | Confinement is lexical outside project-fs: `init platform` writes through symbolic links, iac-fs reads through them |
| security-9 | medium | confirmed | `SECURITY.md:6` | SECURITY.md describes stage 1 and contradicts the code on four points |
| security-10 | low | confirmed | `tests/scenarios/plan-mode.test.ts:396` | Recordings clean today, but the "carries no credential" test would not detect a real key |

### Agents & LLM

| id | severity | verdict | location | title |
|---|---|---|---|---|
| agents-llm-1 | high | confirmed | `src/agents/repair.ts:325` | A user-given owner is withdrawn and asked again every round: interactive `plan` cannot complete for an access whose consumer is new or shared |
| agents-llm-2 | medium | partial | `src/agents/inspector.ts:231` | No context budget: the Inspector's transcript grows to ~1 MB per request, with no token counting and no recovery on overflow |
| agents-llm-3 | high | partial | `src/cli/index.ts:445` | `ask` queries only the embedded fictional SI: no question can be asked about the company's catalogue |
| agents-llm-4 | medium | confirmed | `src/llm/providers.ts:23` | Provider layer with no configuration point: OpenAI forced onto the Responses API, no baseURL/Azure/Bedrock/Ollama, one model for every agent |
| agents-llm-5 | medium | confirmed | `src/llm/runtime.ts:63` | An empty assistant turn goes to Anthropic as `content: []`, a shape the Messages API refuses; Anthropic was never recorded |
| agents-llm-6 | medium | confirmed | `src/agents/architect.ts:172` | The turn given back after a refused terminal call is not forced (Analyst, Inspector, Architect) |
| agents-llm-7 | medium | confirmed | `src/agents/tools/propose-tool.ts:112` | Contradictory instructions: the `propose` tool's description asks for an empty list the schema and the system prompt refuse |
| agents-llm-8 | medium | confirmed | `src/agents/repair.ts:215` | Every new attempt starts from a blank transcript: the Architect must fix "the plan you proposed" without being able to read it |
| agents-llm-9 | medium | confirmed | `src/llm/recording.ts:58` | Recording harness: re-recordings merge (16 dead turns of 67), recorded transcripts are wrong, usage is never written — audit F7 wrongly marked "closed" |
| agents-llm-10 | low | partial | `src/llm/client.ts:34` | No streaming, cancellation or timeout: the `LlmClient` interface blocks the future chat TUI |
| agents-llm-11 | low | confirmed | `src/cli/index.ts:552` | API failures surfaced but misclassified: exit 1 like a gate refusal, a missing key not detected at startup, `finishReason` ignored |

### CLI & UX

| id | severity | verdict | location | title |
|---|---|---|---|---|
| cli-ux-1 | medium | confirmed | `src/cli/index.ts:391` | `validate` on a non-existent path (or a file, or `--help`) answers "0 violations" and exits 0 |
| cli-ux-2 | high | confirmed | `src/core/plan/derive.ts:216` | Question loop: the owner typed for a grant is withdrawn every round and asked again until exit 3 |
| cli-ux-3 | high | confirmed | `src/cli/index.ts:445` | `graph`, `show` and `ask` read only the embedded fictional SI: no way to point them at one's own catalogue |
| cli-ux-4 | high | confirmed | `src/core/plan/recheck.ts:146` | Existing (brownfield) repository: a single pre-existing violation, anywhere, blocks every plan |
| cli-ux-5 | medium | confirmed | `src/cli/commands/plan.ts:436` | No non-interactive way to answer: every grant ends on exit 3 outside a TTY, and the flagship example is documented as exit 0 |
| cli-ux-6 | medium | confirmed | `src/cli/commands/plan.ts:711` | Interactive prompt: possible values never offered, an invalid answer is fatal (exit 1), Ctrl-C treated as a refusal |
| cli-ux-7 | medium | confirmed | `src/cli/index.ts:384` | Raw Node stack traces: `init platform`, `validate` and SI loading do not go through `failed()` |
| cli-ux-8 | low | partial | `src/cli/commands/init.ts:215` | `init --repo` on a non-existent path spends 6 model calls before failing |
| cli-ux-9 | medium | confirmed | `src/cli/commands/ask.ts:54` | Model-written text printed raw to stderr by `ask` (remnant of F5) |
| cli-ux-10 | medium | confirmed | `src/cli/commands/plan.ts:746` | Unstable `--json` contract: two shapes depending on the route, no diff, no version, and prose on some paths |
| cli-ux-11 | medium | partial | `src/cli/index.ts:63` | Inconsistent argument parsing: no `-h`/`--version`, per-command `--help` hit and miss, `ask --help` goes to the model, no "bare intent" form |
| cli-ux-12 | medium | partial | `src/cli/commands/plan.ts:372` | Ready for a TUI/chat? Commands return pre-rendered text, no cancellation; plan.ts mixes five responsibilities |
| cli-ux-13 | low | confirmed | `src/cli/config.ts:65` | `.idp-agent.yml`: `iacRepo` required but never read, lookup limited to the exact cwd, ignored by `plan --from` |
| cli-ux-14 | low | confirmed | `src/cli/README.md:39` | Documentation drift on points the documentation itself declares critical |
| cli-ux-15 | low | confirmed | `src/llm/providers.ts:44` | Model plug-and-play: the API key variable names are documented nowhere, no model id is suggested |

### Backstage domain

| id | severity | verdict | location | title |
|---|---|---|---|---|
| domain-backstage-1 | medium | confirmed | `src/core/schemas/entity.ts:18` | A real Backstage catalogue is mostly refused: `entitySchema` is stricter than Backstage on its most common shapes |
| domain-backstage-2 | high | confirmed | `src/core/schemas/entity.ts:100` | A single file of another kind (Group, System, API, Location…) in the declarations repository blocks every `plan` and fails `validate` |
| domain-backstage-3 | medium | confirmed | `src/context/iac-fs/snapshot.ts:74` | YAML syntax errors and duplicate keys ignored: `validate` goes green on a file Backstage refuses, and a duplicated `owner` is picked silently |
| domain-backstage-4 | medium | confirmed | `src/context/graph/entity-graph.ts:16` | `metadata.namespace` silently erased and `default` hard-coded in six copies of `refOf`: false duplicates, false dangling references, a masked entity |
| domain-backstage-5 | medium | confirmed | `src/cli/index.ts:445` | `ask`, `graph` and `show` hard-wired to the fictional SI: one's own catalogue cannot be queried, and nothing says so |
| domain-backstage-6 | medium | confirmed | `src/core/schemas/vocabulary.ts:12` | The environment annotation `company.fr/env` is hard-coded, not configurable, written into every diff, and the environment guards fall silent without it |
| domain-backstage-7 | medium | confirmed | `src/core/schemas/entity.ts:20` | Unmodelled Backstage fields (system, providesApis/consumesApis, subcomponentOf, title, labels, links, relations) removed without a trace |
| domain-backstage-8 | low | partial | `src/context/provider.ts:21` | The `ContextProvider` seam is too thin for `backstage-http`, and the vocabulary injected into every prompt is unbounded |
| domain-backstage-9 | low | partial | `src/core/schemas/resource-types.ts:12` | The type registry and the "the access carries its consumers" convention are frozen at compile time, and the comment promising otherwise is inaccurate |
| domain-backstage-10 | low | partial | `src/cli/commands/show.ts:10` | `show <name>` picks the first entity when a Component and a Resource share a name, contradicting the README; duplicate resolution differs across modules |
| domain-backstage-11 | info | confirmed | `src/core/schemas/plan.ts:235` | The `catalog-info.yaml` proposed by `init` carries none of the standard Backstage annotations (project-slug, techdocs-ref) nor `spec.system` |

### Architecture & extensibility

| id | severity | verdict | location | title |
|---|---|---|---|---|
| architecture-1 | medium | partial | `src/cli/commands/plan.ts:740` | The deterministic pipeline exists in three diverging copies: the same plan gets two verdicts |
| architecture-2 | high | confirmed | `src/core/plan/derive.ts:216` | A user's owner answer is withdrawn on the next round: provenance is split between `plan.intent` and `SignatureContext.answered` |
| architecture-3 | high | confirmed | `src/cli/index.ts:445` | The `ContextProvider` seam is wired nowhere it matters: `ask`, `graph` and `show` always query the embedded fictional SI |
| architecture-4 | medium | partial | `src/core/plan/recheck.ts:146` | The re-check judges the whole repository, not the plan's changes: a single pre-existing violation blocks every plan |
| architecture-5 | high | confirmed | `src/core/schemas/entity.ts:48` | The domain model is closed and frozen at compile time: kinds, types, namespace and environment annotation |
| architecture-6 | medium | partial | `src/core/plan/policies.ts:332` | The `Operation` union is not an extension point: a 4th operation compiles and silently crosses the gates |
| architecture-7 | medium | partial | `src/core/plan/policies.ts:213` | No plugin story: closed policies and rules, no public API (count of files to touch) |
| architecture-8 | medium | confirmed | `src/llm/providers.ts:23` | LLM layer: closed provider union, no endpoint setting, one model for the five agents |
| architecture-9 | medium | partial | `src/cli/commands/result.ts:6` | No application layer for the chat TUI: one-shot commands, results pre-rendered as text, no router, no cancellation |
| architecture-10 | medium | confirmed | `src/agents/analyst.ts:91` | Agent harness: the bounded loop is copied four times and has already diverged; tool registries do not compose |
| architecture-11 | medium | confirmed | `tests/architecture/dependencies.test.ts:13` | The 13 architecture rules can pass on empty, ignore .mts, and do not cover cli/, which reads both repositories |
| architecture-12 | low | confirmed | `AGENTS.md:264` | The architecture documentation diverges from the code on points the project presents as central |

### Tests

| id | severity | verdict | location | title |
|---|---|---|---|---|
| tests-1 | high | confirmed | `tests/invariants/arbitraries.ts:116` | The "hand-written" file generator knows a single shape, and lets a false "nothing to change." on exit 0 through |
| tests-2 | medium | partial | `tests/scenarios/plan-mode.test.ts:157` | Neither the recorded scenarios nor the rest of the suite pin a grant's diff: a read → readwrite escalation stays green |
| tests-3 | medium | confirmed | `tests/invariants/core.test.ts:124` | The two properties on `signPlan` are about 95% empty and never see a grant, a reference or an update |
| tests-4 | medium | confirmed | `tests/scenarios/question-mode.test.ts:41` | `question-mode.test.ts` does not apply the freshness guard: `mutation-classified-link` replays the answer to another sentence |
| tests-5 | medium | confirmed | `src/llm/recording.ts:59` | Re-recording merges instead of replacing: 16 dead turns (~140 KB) in the tapes, and diffs impossible to review |
| tests-6 | medium | confirmed | `src/llm/runtime.ts:21` | A turn's fingerprint ignores what the model sees of the tool schemas (min, max, regex, describe) and depends on Zod internals |
| tests-7 | low | partial | `tests/setup/offline.ts:21` | The offline guard covers only `globalThis.fetch`: node:http, node:net, undici and WebSocket open sockets, and some tests build real authenticated requests |
| tests-8 | medium | confirmed | `tests/unit/init-command.test.ts:24` | The suite depends on the contributor's shell: exported `IDP_PROVIDER`/`IDP_MODEL` fail 2 tests, and `IDP_RECORDING=record` would record unit tests |
| tests-9 | medium | partial | `tests/scenarios/plan-mode.test.ts:138` | Any prompt change turns CI red until a paid re-recording: the cause of the WIP failures, and nothing explains it to the contributor |
| tests-10 | medium | partial | `src/llm/runtime.ts:60` | The path every real user takes (live mode, `toMessages`, the anthropic and openai adapters) is never run by the suite |
| tests-11 | medium | confirmed | `docs/audit-attacks/turn-usage.test.ts:40` | The `docs/audit-attacks` oracle counts as "closed" two defects that crash on a wrong path, and `plan-outcomes` no longer replays anything |
| tests-12 | low | confirmed | `tests/architecture/dependencies.test.ts:13` | The architecture rules pass silently if a folder is renamed or an import does not resolve |
| tests-13 | low | confirmed | `tests/scenarios/plan-mode.test.ts:29` | Run hygiene: ~178 temporary directories left per run, and a 10-minute timeout per scenario even in replay |
| tests-14 | info | confirmed | `tests/unit/reviewer.test.ts:344` | Some tests pin the wording of prompts rather than a behaviour (judgement) |

### Docs & credibility

| id | severity | verdict | location | title |
|---|---|---|---|---|
| docs-1 | medium | confirmed | `examples/README.md:14` | `pnpm demo` and `examples/README.md`: the only documented keyless path fails at step 2 |
| docs-2 | medium | partial | `README.md:62` | No documented path to try the tool on one's own repository, with one's own key |
| docs-3 | medium | confirmed | `SECURITY.md:6` | SECURITY.md still describes stage 1: "no model, no network" and contradictory guarantees |
| docs-4 | medium | confirmed | `AGENTS.md:58` | Wrong test count, "Current state" and design status, although AGENTS.md itself warns about that drift |
| docs-5 | medium | partial | `README.md:6` | The README's first screen says neither "Backstage", nor what you type, nor what you get |
| docs-6 | medium | confirmed | `src/cli/index.ts:617` | No keyless demonstration of the multi-agent loop, though it is presented as "the subject" |
| docs-7 | medium | partial | `src/cli/commands/plan.ts:60` | The functional scope and the "after the merge" boundary are written nowhere for the user |
| docs-8 | medium | partial | `README.md:121` | The target vision (Claude Code-style chat, questions on the real SI, plugins) is absent from the roadmap and the design |
| docs-9 | low | partial | `src/agents/README.md:53` | Folder READMEs contradict the code or the design (agents, scaffold, cli, core) |
| docs-10 | low | confirmed | `docs/audit-report.md:6` | Audit report: audited commit not publicly reachable, "this branch" references frozen on main, a misleadingly named oracle |
| docs-11 | info | confirmed | `AGENTS.md:245` | Dense, aphoristic prose style: an asset in the ADRs, a drag in the README, AGENTS.md and commits |
| docs-12 | info | confirmed | `docs/plans/stage-4-preview-only.md:3` | About 7,000 lines of process documents addressed to "agentic workers", on display in a portfolio |

### Build & CI

| id | severity | verdict | location | title |
|---|---|---|---|---|
| build-ci-1 | medium | partial | `src/cli/index.ts:344` | The published package can query only the embedded fictional SI: graph/show/ask ignore the user's repository |
| build-ci-2 | medium | confirmed | `scripts/smoke.mjs:200` | `pnpm smoke` runs the repository's dist/, not the tarball: removing `fixtures` from `files` stays green |
| build-ci-3 | medium | confirmed | `package.json:44` | No dist/ cleaning and no `prepack`: a ghost file `__before_probe.js` is in the tarball |
| build-ci-4 | medium | confirmed | `scripts/demo.sh:23` | `pnpm demo` stops at step 2 (exit 3) and runs `rm -rf` on the path given as argument, unguarded |
| build-ci-5 | low | partial | `package.json:3` | Burned version 0.1.0-rc.1 still in place: every scaffolded repository pins a version that can never exist |
| build-ci-6 | low | partial | `AGENTS.md:300` | The npm name `idp-agent` was fully unpublished: anyone can claim it, while the docs and the template rely on `npx --yes idp-agent` |
| build-ci-7 | low | confirmed | `templates/iac-repo/github/workflows/validate.yml:19` | The workflow generated for the authorisation repository applies no least privilege (no `permissions`, persisted token) before running `npx --yes` |
| build-ci-8 | low | confirmed | `.github/workflows/ci.yml:1` | Project CI: no `permissions`, `concurrency` or `timeout-minutes`, Linux only, and the demo and attacks never run |
| build-ci-9 | low | confirmed | `package.json:52` | Implicit dependency policy: exact pins and carets mixed, no `packageManager`, no update bot |
| build-ci-10 | low | confirmed | `package.json:39` | No linter or formatter in the toolchain |
| build-ci-11 | low | confirmed | `README.md:11` | Stale installation and examples documentation; API keys never named |
| build-ci-12 | low | confirmed | `src/cli/index.ts:62` | Neither `--version` nor `-h`: exit 2 "unknown command" |

### Recent changes (formerly work in progress)

| id | severity | verdict | location | title |
|---|---|---|---|---|
| wip-diff-1 | medium | confirmed | `src/core/plan/sign.ts:344` | `created()` lets an operation vouch for itself: a grant that depends on itself signs `derived` and passes the four free gates |
| wip-diff-2 | medium | confirmed | `src/agents/repair.ts:561` | `effectsOf` says "would be written to the repository" for an `update-entity` that changes no byte, contradicting the same prompt's `targets` section |
| wip-diff-3 | high | confirmed | `src/agents/reviewer.ts:100` | The Reviewer vetoes the §7.5 "missing resource" branch 8b5692a was meant to unblock; the new facts give it nothing to accept it with |
| wip-diff-4 | medium | confirmed | `src/core/plan/sign.ts:219` | `created()` vouches for references to Components that `planEdits` discards: "both are in one diff" is false for them |
| wip-diff-5 | low | partial | `src/agents/reviewer.ts:93` | The Reviewer's SYSTEM prompt did not follow: "That is everything" and no instruction on the new sections; `effects` duplicates a decision the engine now takes deterministically |
| wip-diff-6 | medium | confirmed | `tests/scenarios/plan-mode.test.ts:138` | Exact cause of the red scenarios and real cost of a prompt change: the whole scenario is re-recorded, freshness masks the invariants, and the docs promise the opposite |
| wip-diff-7 | medium | confirmed | `tests/scenarios/plan-mode.test.ts:158` | `endedWell` accepts 0, 1 or 3: the scenarios do not detect a regression of the path their name carries |
| wip-diff-8 | low | confirmed | `src/cli/commands/plan.ts:981` | The `...facts` spread contradicts the promise "a new fact breaks every caller's build", and the three fields are declared twice |
| wip-diff-9 | low | confirmed | `src/agents/repair.ts:528` | Unbounded free text from the repository reaches the Reviewer under the heading of facts established by the engine |
| wip-diff-10 | low | confirmed | `tests/unit/repair.test.ts:970` | The new tests cover the nominal path, but neither the breaking cases nor what their title promises |
| wip-diff-11 | low | confirmed | `src/core/plan/sign.ts:191` | Documentation drift and duplication introduced by the diff |
| wip-diff-12 | low | confirmed | `src/llm/runtime.ts:21` | The cassette digest hashes Zod's internal representation, not the JSON Schema sent to the provider |

### Product gaps

| id | severity | verdict | location | title |
|---|---|---|---|---|
| product-gap-1 | high | partial | `src/cli/index.ts:445` | `ask`, `graph` and `show` read only the fictional SI: one's own catalogue cannot be queried |
| product-gap-2 | high | partial | `src/cli/commands/plan.ts:793` | On an existing repository, the slightest pre-existing violation blocks every plan |
| product-gap-3 | high | confirmed | `src/core/schemas/entity.ts:28` | The read schema is much narrower than Backstage: a real catalogue is largely rejected |
| product-gap-4 | medium | confirmed | `src/context/graph/entity-graph.ts:16` | `metadata.namespace` silently dropped: two distinct entities become a duplicate |
| product-gap-5 | medium | confirmed | `src/core/schemas/vocabulary.ts:12` | The environment is read from and written to a hard-coded `company.fr/env` annotation |
| product-gap-6 | medium | partial | `src/core/schemas/query.ts:8` | The Analyst's query surface does not hold at 300 services |
| product-gap-7 | medium | partial | `README.md:106` | Nothing turns a merged declaration into infrastructure |
| product-gap-8 | medium | confirmed | `src/core/schemas/resource-types.ts:47` | Closed, compiled type registry: a bucket, a topic or a queue cannot be declared without forking |
| product-gap-9 | medium | confirmed | `src/llm/providers.ts:23` | Plugging in one's key: undocumented variables, Anthropic never exercised, no enterprise gateway |
| product-gap-10 | low | partial | `src/llm/runtime.ts:164` | Invisible cost: no token counter, and up to about a hundred calls for one `plan` |
| product-gap-11 | low | partial | `src/cli/index.ts:526` | Outside a terminal, no access grant can complete |
| product-gap-12 | medium | confirmed | `examples/README.md:14` | First contact contradicts the binary: an example announced as exit 0, a demo that stops, SECURITY.md left at stage 1 |
| product-gap-13 | high | confirmed | `docs/design.md:923` | The Claude Code-style chat is not in the architecture: no session, router, interruption or multi-turn provenance rule |
| product-gap-14 | low | confirmed | `src/core/paths/entity-path.ts:28` | Windows not covered: an annotated path there would be declared misplaced |
| product-gap-15 | info | confirmed | `src/context/provider.ts:19` | Step 1: "bring your catalogue" (reading the real SI) |
| product-gap-16 | info | confirmed | `src/core/plan/recheck.ts:50` | Step 2: an "existing repository mode" for `plan` |
| product-gap-17 | info | confirmed | `src/llm/client.ts:31` | Step 3: lay down the session core before Ink |
| product-gap-18 | info | confirmed | `src/agents/tools/graph-tools.ts:111` | Step 4: Analyst v2 for real questions about the SI |
| product-gap-19 | info | confirmed | `README.md:9` | Step 5: a 10-minute trial kit for an employer |

### Runtime probes

| id | severity | verdict | location | title |
|---|---|---|---|---|
| runtime-probe-1 | high | confirmed | `src/core/plan/grant.ts:97` | A lying "already declared": `restates` compares only the access level |
| runtime-probe-2 | high | confirmed | `src/core/yaml/surgery.ts:202` | `update-entity` silently has no effect on common YAML shapes (no `---`, 4-space indentation, BOM, comment) |
| runtime-probe-3 | medium | confirmed | `src/context/iac-fs/snapshot.ts:35` | `validate` concludes "compliant" (exit 0) on what it could not read |
| runtime-probe-4 | medium | confirmed | `src/context/iac-fs/snapshot.ts:75` | YAML syntax errors ignored: validate accepts a file the catalogue will reject |
| runtime-probe-5 | high | confirmed | `src/core/schemas/entity.ts:8` | The reader refuses standard Backstage catalogue content and overwrites namespaces |
| runtime-probe-6 | high | confirmed | `src/core/plan/recheck.ts:146` | A single pre-existing violation, unrelated to the plan, blocks every plan, and the repair loop pays for it three times |
| runtime-probe-7 | medium | partial | `src/cli/index.ts:445` | graph, show and ask wired to the demo fixture, with no way to target the company's SI |
| runtime-probe-8 | medium | confirmed | `src/cli/index.ts:392` | Raw Node stack traces on ordinary disk cases, and a single file aborts the whole validation |
| runtime-probe-9 | medium | partial | `examples/README.md:14` | The demo and the examples announce a diff the binary never produces outside a TTY, and the level question does not give the possible answers |
| runtime-probe-10 | low | partial | `src/cli/commands/show.ts:10` | `show <name>` silently picks one when a Component and a Resource share a name |
| runtime-probe-11 | medium | confirmed | `src/scaffold/write.ts:50` | Purely lexical confinement: init platform writes outside the root through a symbolic link, and iac-fs reads outside the repository |
| runtime-probe-12 | low | confirmed | `src/cli/render/diff.ts:46` | Text from the repository reaches the terminal unsanitised (diff and policy messages) |
| runtime-probe-13 | low | confirmed | `src/cli/index.ts:92` | Command-line rough edges: empty string = current directory, `ask --help` goes to the model, retry without warning |
| runtime-probe-14 | low | confirmed | `src/cli/index.ts:552` | Missing API key: exit 1 and an SDK message about an `apiKey` parameter the CLI does not have |
| runtime-probe-15 | low | confirmed | `src/cli/index.ts:413` | The `MainDeps.cwd` seam is ignored by plan and validate, and `--json` can emit prose |

### Follow-up — stage 5 readiness

| id | severity | verdict | location | title |
|---|---|---|---|---|
| gap-stage5-readiness-1 | critical | confirmed | `src/cli/commands/plan.ts:332` | "nothing to change." on exit 0 when the surgery did not find the entity: the brief's central idempotence claim is false |
| gap-stage5-readiness-2 | medium | partial | `src/core/schemas/plan.ts:327` | `create-catalog-info.repoPath` is a free path in a Plan, and the signature classifies it `echoed`: the §9.4 test "a Plan carrying a path outside the repository is rejected" does not hold |
| gap-stage5-readiness-3 | medium | partial | `src/context/iac-fs/snapshot.ts:32` | The preview is computed on the working tree, ignored files and uncommitted changes included: a branch created from HEAD would carry a change the user did not see |
| gap-stage5-readiness-4 | medium | partial | `src/context/iac-fs/snapshot.ts:46` | Purely lexical confinement on the declarations-repository side, the very one stage 5 will write to: a symbolic link is read, previewed, and would be written outside the repository |
| gap-stage5-readiness-5 | low | partial | `src/core/plan/sign.ts:461` | The `SignedPlan` brand is not proof of authorisation: issued at gate [2], forgeable by a cast, and the bytes (`FileEdit`) carry no mark |
| gap-stage5-readiness-6 | medium | confirmed | `src/cli/commands/plan.ts:896` | Nothing detects a change between preview and write; on the intent route, the snapshot and the bytes are even read on either side of a model call |
| gap-stage5-readiness-7 | low | partial | `src/scaffold/write.ts:57` | The `FileIO.writeNew` "precedent" can neither modify, rename, delete nor fsync, and a failure part-way loses the list of what was written |
| gap-stage5-readiness-8 | high | confirmed | `src/cli/commands/init.ts:353` | Stage 5 writes to TWO repositories: `FileEdit` does not say which, and `catalog-info.yaml`'s `before` comes from a capped snapshot, so an unread existing file is previewed as a creation |
| gap-stage5-readiness-9 | medium | confirmed | `tests/architecture/dependencies.test.ts:104` | Only one of the 13 architecture rules walks the transitive closure, and none restricts who writes outside `scaffold/` |
| gap-stage5-readiness-10 | medium | confirmed | `src/cli/commands/plan.ts:700` | The `plan --from` route crosses only four gates (no Reviewer) and does not read `.idp-agent.yml`: "every plan crosses the five gates" is false |
| gap-stage5-readiness-11 | medium | confirmed | `tests/invariants/arbitraries.ts:116` | The "applying twice == applying once" invariant would pass for a writer that writes nothing, and the generators never produce the failing shapes |
| gap-stage5-readiness-12 | low | partial | `docs/design.md:100` | Branch naming, collisions and concurrent grants: no plan identity, and the §4.3 rule "two concurrent declarations never write the same file" is false for `update-entity` |
| gap-stage5-readiness-13 | medium | confirmed | `src/cli/commands/result.ts:6` | Confirmation and result seams: `Ask` accepts only questions about a plan path, `CommandResult` is only text, and the edits die in `renderPreview` |
| gap-stage5-readiness-14 | low | confirmed | `docs/design.md:778` | Documentation drift that would mislead the stage 5 implementer (writer location, gate order, file name) |

### Follow-up — `ask` grounding

| id | severity | verdict | location | title |
|---|---|---|---|---|
| gap-ask-grounding-1 | high | confirmed | `src/cli/index.ts:445` | `ask` (like `graph` and `show`) can query only the embedded fictional SI: no question can be asked about the company's SI |
| gap-ask-grounding-2 | medium | partial | `src/agents/analyst.ts:212` | The witnesses guarantee the cited entities exist, not their relevance nor completeness: a wrong or partial answer exits 0 |
| gap-ask-grounding-3 | medium | partial | `src/agents/analyst.ts:220` | The `nothing` outcome is refused as soon as a tool returned a row, and accepted when the filter was on an undeclared field |
| gap-ask-grounding-4 | medium | confirmed | `src/core/schemas/query.ts:38` | `Answer` carries only entity refs: owner, yes/no, count, path and dangling references cannot be expressed, and the final event loses the outcome |
| gap-ask-grounding-5 | low | partial | `src/context/graph/entity-graph.ts:134` | The graph tools do not cover transitive questions: `consumers` stops at the first Component despite "any chain", and no transitive descent exists |
| gap-ask-grounding-6 | low | partial | `src/agents/summary.ts:13` | Free text from the repository (Component type, environment annotation) reaches the Supervisor's and the Analyst's prompts as is, line breaks included |
| gap-ask-grounding-7 | medium | confirmed | `src/agents/supervisor.ts:39` | The Supervisor fails on "Question.", "\*\*QUESTION\*\*" or any decorated output: exit 3, a duplicated and unusable message, no retry |
| gap-ask-grounding-8 | low | partial | `src/cli/commands/ask.ts:41` | Routing leads to dead ends: a stale message on a change request, no recourse against a question classified MUTATION, and `plan` classifies nothing |
| gap-ask-grounding-9 | medium | partial | `src/context/graph/entity-graph.ts:15` | `metadata.namespace` silently dropped and the environment read only from `company.fr/env`: on a real Backstage catalogue, entities merge and a question returns the wrong service |
| gap-ask-grounding-10 | medium | confirmed | `src/cli/commands/ask.ts:54` | `ask` writes model text to stderr without `plain()`: terminal escape sequences get through, contrary to what SECURITY.md claims |
| gap-ask-grounding-11 | low | confirmed | `src/cli/commands/ask.ts:93` | The truncation note accumulates every search in the session, not the one that produced the answer |
| gap-ask-grounding-12 | low | confirmed | `src/context/graph/summary.ts:56` | The injected summary enumerates the whole vocabulary without bound, and also goes to the classifier, which does not need it |
| gap-ask-grounding-13 | low | partial | `tests/scenarios/question-mode.test.ts:66` | Question mode has only 4 recordings, from a single model, and the consumers assertion accepts a wrong answer |

### Follow-up — provider matrix

| id | severity | verdict | location | title |
|---|---|---|---|---|
| gap-provider-matrix-1 | critical | confirmed | `src/core/schemas/query.ts:38` | The `answer` and `verdict` tools have no root `type: "object"`: `ask` and `plan` fail at Anthropic |
| gap-provider-matrix-2 | medium | confirmed | `src/llm/runtime.ts:165` | `finishReason` ignored: a truncated (`length`) or refused (`content-filter`) output is misdiagnosed to the user |
| gap-provider-matrix-3 | medium | confirmed | `src/llm/runtime.ts:67` | A sterile turn is replayed as an empty assistant message: rejected by Anthropic, probably by Mistral, silently dropped at OpenAI |
| gap-provider-matrix-4 | low | partial | `src/llm/runtime.ts:154` | Non-streamed calls, no maximum delay or cancellation, `max_tokens` at 128,000 at Anthropic: the `LlmClient` contract will not suffice for the chat TUI |
| gap-provider-matrix-5 | medium | confirmed | `tests/unit/runtime.test.ts:130` | No test guarantees the providers: Anthropic never recorded, Mistral never in plan mode, no HTTP body checked, the README silent on keys |
| gap-provider-matrix-6 | low | confirmed | `src/llm/runtime.ts:154` | OpenAI: `store` is not sent, so it is `true`, and content read from the user's repository is retained at OpenAI |
| gap-provider-matrix-7 | low | partial | `src/llm/runtime.ts:40` | The neutral transcript loses the reasoning (`thinking` and `reasoning`) and the error status of tool results |

### Follow-up — `init` on real repositories

| id | severity | verdict | location | title |
|---|---|---|---|---|
| gap-init-real-repos-1 | high | confirmed | `src/context/project-fs/snapshot.ts:641` | The 200-file budget is spent in alphabetical order: on realistic repositories, the manifest and the deployments fall out |
| gap-init-real-repos-2 | high | confirmed | `src/cli/index.ts:367` | `init` ends on questions that cannot be answered: on a repository with no declaration yet, the route never produces a diff |
| gap-init-real-repos-3 | high | confirmed | `src/cli/commands/init.ts:356` | An existing declaration is not recognised: the preview proposes a duplicate or a new file (no `---`, `.yml`, or outside the snapshot) |
| gap-init-real-repos-4 | medium | confirmed | `src/context/project-fs/snapshot.ts:97` | The secret filter excludes ordinary manifests: `jsonwebtoken`, `@octokit/auth-token`, `existingSecret` in a Helm chart, a README with a placeholder |
| gap-init-real-repos-5 | medium | partial | `src/cli/commands/init.ts:278` | The Inspector's facts vouch for themselves: nothing checks that a snapshot file states them |
| gap-init-real-repos-6 | medium | confirmed | `src/cli/index.ts:365` | `init --repo <non-existent folder>` does not return exit 2 and calls the model anyway |
| gap-init-real-repos-7 | medium | partial | `src/agents/tools/project-tools.ts:70` | Monorepo: one Component per run, and targeting a sub-package loses the root's context |
| gap-init-real-repos-8 | low | partial | `src/cli/commands/plan.ts:60` | A successful `init`'s output does not say what comes next, and its closing sentence does not apply to init |
| gap-init-real-repos-9 | low | confirmed | `src/agents/tools/project-tools.ts:200` | Project tools: `read_file` breaks its contract for files under an excluded folder or beyond the cap, and paths are not normalised |
| gap-init-real-repos-10 | low | confirmed | `docs/design.md:626` | §7.3 promises to inspect the "git remote", but nothing reads it: the produced catalog-info has no source annotation |
