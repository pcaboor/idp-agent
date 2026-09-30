#!/usr/bin/env node
import { main } from './index.js'
import { cacheRootOf } from './personal.js'

// The cache root is handed in here and nowhere else: `main` keeps no
// catalogue read unless it is given one, so no test's run can write under a
// real home (docs/plans/backstage-http-slice-2.md, Task 2.3).
process.exitCode = await main(process.argv.slice(2), {
  cacheRoot: cacheRootOf(process.env, process.platform, process.getuid?.()),
})
