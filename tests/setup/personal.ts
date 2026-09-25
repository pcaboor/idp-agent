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
 * looks, on every platform, so HOME and APPDATA are never reached and are left
 * alone: git, and whatever else a test starts, may need them. A test that
 * wants a configuration writes one in its own scratch directory and injects
 * the environment that names it.
 *
 * IDP_MLFLOW_TRACKING_URI and IDP_MLFLOW_EXPERIMENT_ID are removed too, for
 * the same reason and a worse outcome: the scenarios hand `process.env` to
 * `main`, and a developer who exported them would have every replayed run's
 * full prompts posted to their MLflow. IDP_TRACE_DIR is left alone. It writes
 * files on this machine, sends nothing anywhere, and it is how the tapes are
 * traced on purpose: `IDP_TRACE_DIR=.traces pnpm vitest run tests/scenarios`.
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
