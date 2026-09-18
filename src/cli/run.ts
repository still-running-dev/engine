/**
 * The CLI's actual logic, factored out of `cli.ts` so it can be imported and
 * tested directly — `cli.ts` itself is only ever meant to be executed, never
 * imported, because it touches `__dirname` at its top level.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION } from '../index.js';
import { CliUsageError, parseCliArgs, SEVERITIES } from './args.js';
import { analyzePath } from './collect.js';
import { anyMeetsSeverity, colorEnabled, formatHuman, toJsonOutput } from './format.js';

const HELP = `Usage: still-running <file.json|directory> [options]

  --json                 machine-readable output (see README for the shape)
  --min-severity=LEVEL   only show findings at or above LEVEL
  --fail-on=LEVEL        exit non-zero if any finding is at or above LEVEL
  --version              print the package version
  --verify               with --version, also print SCHEMA_VERSION and the
                          sha256 of dist/index.js — compare against the
                          footer at stillrunning.dev
  --help                 print this message

LEVEL is one of: ${SEVERITIES.join(', ')}.

Exit code is 0 even when findings exist, so this can sit in CI without
breaking a pipeline. Only --fail-on changes that.`;

/** `dist/../package.json` from `moduleDir` — the root package.json either way. */
function readCliVersion(moduleDir: string): string {
  const pkg = JSON.parse(readFileSync(join(moduleDir, '..', 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

function hashDistIndex(moduleDir: string): string {
  return createHash('sha256').update(readFileSync(join(moduleDir, 'index.js'))).digest('hex');
}

/**
 * `moduleDir` is injected rather than read from `__dirname` here so this stays
 * importable in tests without depending on a build having happened: it is the
 * directory containing this module's compiled sibling `index.js` — `dist/` in
 * production, an arbitrary fixture directory in a test.
 */
export function run(argv: string[], moduleDir: string): number {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }

  if (options.help) {
    console.log(HELP);
    return 0;
  }

  if (options.version) {
    const cliVersion = readCliVersion(moduleDir);
    if (options.verify) {
      console.log([cliVersion, String(SCHEMA_VERSION), hashDistIndex(moduleDir)].join('\n'));
    } else {
      console.log(cliVersion);
    }
    return 0;
  }

  if (!options.path) {
    console.error(`Expected a file or directory to analyse.\n\n${HELP}`);
    return 2;
  }

  let outcomes;
  try {
    outcomes = analyzePath(options.path);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  if (options.json) {
    const cliVersion = readCliVersion(moduleDir);
    const output = toJsonOutput(outcomes, {
      schemaVersion: SCHEMA_VERSION,
      cliVersion,
      minSeverity: options.minSeverity,
    });
    console.log(JSON.stringify(output, null, 2));
  } else {
    const color = colorEnabled(process.env, Boolean(process.stdout.isTTY));
    console.log(formatHuman(outcomes, { minSeverity: options.minSeverity, color }));
  }

  if (options.failOn && anyMeetsSeverity(outcomes, options.failOn)) {
    return 1;
  }
  return 0;
}
