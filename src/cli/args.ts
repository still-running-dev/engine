/**
 * Argument parsing for the `still-running` bin. Pure — no I/O, no process
 * access — so it is testable without a subprocess.
 */

import { parseArgs } from 'node:util';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type CliSeverity = (typeof SEVERITIES)[number];

export interface CliOptions {
  path: string | null;
  json: boolean;
  minSeverity: CliSeverity | null;
  failOn: CliSeverity | null;
  version: boolean;
  verify: boolean;
  help: boolean;
}

/** Bad flags and bad input — distinct from a finding, never a stack trace. */
export class CliUsageError extends Error {}

function parseSeverity(value: string | undefined, flag: string): CliSeverity | null {
  if (value === undefined) return null;
  if (!(SEVERITIES as readonly string[]).includes(value)) {
    throw new CliUsageError(`${flag}=${value} is not a severity. Use one of: ${SEVERITIES.join(', ')}.`);
  }
  return value as CliSeverity;
}

export function parseCliArgs(argv: string[]): CliOptions {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        'min-severity': { type: 'string' },
        'fail-on': { type: 'string' },
        version: { type: 'boolean', default: false },
        verify: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    throw new CliUsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length > 1) {
    throw new CliUsageError(`Expected a single file or directory, got: ${positionals.join(', ')}`);
  }

  return {
    path: positionals[0] ?? null,
    json: Boolean(values.json),
    minSeverity: parseSeverity(values['min-severity'] as string | undefined, '--min-severity'),
    failOn: parseSeverity(values['fail-on'] as string | undefined, '--fail-on'),
    version: Boolean(values.version),
    verify: Boolean(values.verify),
    help: Boolean(values.help),
  };
}
