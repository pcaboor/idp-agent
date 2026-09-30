/**
 * The suite must never read the developer's own configuration — the
 * declarations repository they set in IDP_REPO, or in
 * `~/.config/idp-agent/config.yml` — for the reason `offline.ts` blocks the
 * network: a test that calls `main` without injecting an environment reads
 * `process.env`, and would otherwise answer about whatever repository happens
 * to be configured on the machine running it, and pass or fail on that.
 *
 * IDP_REPO is removed, and XDG_CONFIG_HOME points into the run directory,
 * where no file is. XDG_CONFIG_HOME is the first place `cli/personal.ts`
 * looks, on every platform, so HOME and APPDATA are never reached from here.
 * HOME is moved all the same, by `forge.ts`, which runs after this file: the
 * git launcher removes every GIT_* and so reads `$HOME/.gitconfig`, where a
 * developer's global core.sshCommand or insteadOf would carry a push test to
 * GitHub, and gh would find its login under HOME. A test that wants a
 * configuration writes one in its own scratch directory and injects the
 * environment that names it.
 *
 * IDP_MLFLOW_TRACKING_URI and IDP_MLFLOW_EXPERIMENT_ID are removed too, for
 * the same reason and a worse outcome: the scenarios hand `process.env` to
 * `main`, and a developer who exported them would have every replayed run's
 * full prompts posted to their MLflow. IDP_TRACE_DIR is left alone. It writes
 * files on this machine, sends nothing anywhere, and it is how the tapes are
 * traced on purpose: `IDP_TRACE_DIR=.traces pnpm vitest run tests/scenarios`.
 *
 * XDG_CACHE_HOME points into the run directory too, at a folder no one made,
 * for a binary a test starts: `bin.ts` hands `main` the cache root it names
 * (`cacheRootOf`), and `main` never reads the variable itself, so a test that
 * calls `main` keeps nothing unless it hands a root in. A test that starts the
 * binary against a catalogue passes an XDG_CACHE_HOME of its own, so two
 * spawned runs never share a copy.
 *
 * A setup file, so it runs in every worker before any test, and a process a
 * test starts — the CLI — inherits it. `tests/unit/personal-config.test.ts`
 * fails if any of that stops being true.
 */
import { tmpdir } from 'node:os'
import path from 'node:path'

delete process.env['IDP_REPO']
delete process.env['IDP_MLFLOW_TRACKING_URI']
delete process.env['IDP_MLFLOW_EXPERIMENT_ID']
process.env['XDG_CONFIG_HOME'] = path.join(tmpdir(), 'xdg-config')
process.env['XDG_CACHE_HOME'] = path.join(tmpdir(), 'xdg-cache')
