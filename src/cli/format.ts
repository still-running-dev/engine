/**
 * Rendering: human-readable (grouped by severity, the route through the graph
 * included) and --json (a stable, documented shape). Colour is a parameter,
 * never read from the environment in here, so this stays testable.
 */

import type { AnalysisResult, Finding, Severity } from '../core/model.js';
import { SEVERITY_ORDER } from '../core/model.js';
import type { CliSeverity } from './args.js';
import type { FileOutcome } from './collect.js';

export function meetsSeverity(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER[severity] <= SEVERITY_ORDER[threshold];
}

export function filterFindings(findings: Finding[], minSeverity: Severity | null): Finding[] {
  if (!minSeverity) return findings;
  return findings.filter((f) => meetsSeverity(f.severity, minSeverity));
}

/** Unfiltered — --fail-on judges the real result, not what --min-severity chose to show. */
export function anyMeetsSeverity(outcomes: FileOutcome[], threshold: Severity): boolean {
  return outcomes.some((o) => o.ok && o.result.findings.some((f) => meetsSeverity(f.severity, threshold)));
}

// ---------------------------------------------------------------- colour

const CODES = {
  reset: '[0m',
  bold: '[1m',
  red: '[31m',
  yellow: '[33m',
  magenta: '[35m',
  cyan: '[36m',
  gray: '[90m',
} as const;

const SEVERITY_COLOR: Record<Severity, keyof typeof CODES> = {
  critical: 'red',
  high: 'magenta',
  medium: 'yellow',
  low: 'cyan',
  info: 'gray',
};

/** honours https://no-color.org: presence of NO_COLOR disables colour, any value. */
export function colorEnabled(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  return isTTY && !('NO_COLOR' in env);
}

function paint(text: string, code: keyof typeof CODES, enabled: boolean): string {
  return enabled ? `${CODES[code]}${text}${CODES.reset}` : text;
}

// ---------------------------------------------------------------- human

const SEVERITY_ORDER_LIST: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function formatFinding(f: Finding, color: boolean): string {
  const lines = [`  [${f.checkId}] ${f.title}`];
  if (f.nodeLabel) lines.push(`    node: ${f.nodeLabel}`);
  lines.push(indent(`if it goes quiet: ${f.ifItGoesQuiet}`, '    '));
  // `detail` is where the route through the graph lives for zero-write
  // findings — the part that makes a finding checkable, not just asserted.
  lines.push(indent(f.detail, '    '));
  if (f.howToCheck) lines.push(indent(`how to check: ${f.howToCheck}`, '    '));
  return lines.join('\n');
}

function formatAnalysis(result: AnalysisResult, minSeverity: Severity | null, color: boolean): string {
  const findings = filterFindings(result.findings, minSeverity);
  if (findings.length === 0) {
    return `  no findings${minSeverity ? ` at or above ${minSeverity}` : ''}.`;
  }

  const bySeverity = new Map<Severity, Finding[]>();
  for (const f of findings) {
    const list = bySeverity.get(f.severity) ?? [];
    list.push(f);
    bySeverity.set(f.severity, list);
  }

  return SEVERITY_ORDER_LIST.filter((s) => bySeverity.has(s))
    .map((severity) => {
      const list = bySeverity.get(severity)!;
      const label = paint(`${severity.toUpperCase()} (${list.length})`, SEVERITY_COLOR[severity], color);
      return `${label}\n${list.map((f) => formatFinding(f, color)).join('\n\n')}`;
    })
    .join('\n\n');
}

function formatFileHuman(outcome: FileOutcome, minSeverity: Severity | null, color: boolean): string {
  if (!outcome.ok) {
    return `${paint(outcome.file, 'bold', color)}\n  could not parse: ${outcome.error}`;
  }
  const { result } = outcome;
  const header = `${paint(outcome.file, 'bold', color)} — ${result.workflowName} (${result.platform}, ${result.nodeCount} nodes)`;
  return `${header}\n\n${formatAnalysis(result, minSeverity, color)}`;
}

export function formatHuman(
  outcomes: FileOutcome[],
  opts: { minSeverity: CliSeverity | null; color: boolean },
): string {
  return outcomes.map((o) => formatFileHuman(o, opts.minSeverity, opts.color)).join('\n\n');
}

// ---------------------------------------------------------------- json

/**
 * Documented, stable shape for --json:
 *
 *   {
 *     schemaVersion: number,   // AnalysisResult.schemaVersion, see SCHEMA_VERSION
 *     cliVersion: string,      // this package's version
 *     results: [
 *       { file, ok: true, ...AnalysisResult } |
 *       { file, ok: false, error: string }
 *     ]
 *   }
 *
 * Always this shape, whether `path` was one file or a directory of many —
 * `results` just has one entry instead of several.
 */
export interface CliJsonOutput {
  schemaVersion: number;
  cliVersion: string;
  results: CliJsonEntry[];
}

export type CliJsonEntry = ({ file: string; ok: true } & AnalysisResult) | { file: string; ok: false; error: string };

export function toJsonOutput(
  outcomes: FileOutcome[],
  meta: { schemaVersion: number; cliVersion: string; minSeverity: CliSeverity | null },
): CliJsonOutput {
  return {
    schemaVersion: meta.schemaVersion,
    cliVersion: meta.cliVersion,
    results: outcomes.map((o): CliJsonEntry => {
      if (!o.ok) return { file: o.file, ok: false, error: o.error };
      return { file: o.file, ok: true, ...o.result, findings: filterFindings(o.result.findings, meta.minSeverity) };
    }),
  };
}
