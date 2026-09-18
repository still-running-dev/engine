#!/usr/bin/env node
/**
 * Bin entry for `still-running`. Deliberately just this — all real logic
 * lives in `./cli/run.js` so it can be imported and tested without executing
 * a process. This file is never imported, only run, so it is the one place
 * allowed to reach for `__dirname`.
 */

import { run } from './cli/run.js';

process.exitCode = run(process.argv.slice(2), __dirname);
