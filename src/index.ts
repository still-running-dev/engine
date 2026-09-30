/**
 * stillrunning.dev — Workflow Health Check
 *
 * Public entry point. Everything here runs in the browser: no network calls, no
 * storage, nothing leaves the page. The only thing the server ever learns is
 * three counters (pastes, results shown, emails), sent separately.
 *
 * Check order is deliberately inverted from the original spec. Zero-write and
 * credential expiry lead because they are the two nobody else does; error
 * handling is last because six free tools already ship it.
 *
 * The exports below are the entire public API — see CHANGELOG.md for what
 * 2.0.0 removed and what later minors added. Anything not exported here is an
 * implementation detail that can change without a major version.
 */

import type { AnalysisResult, CredentialRef, Finding, NodeRole, Workflow } from './core/model.js';
import { SEVERITY_ORDER } from './core/model.js';
import { checkZeroWrite, findAlertNodes } from './core/checks/zero-write.js';
import { checkCadence, checkCredentialExpiry, checkErrorHandling } from './core/checks/others.js';
import { checkProtections } from './core/checks/protections.js';
import { isN8nWorkflow, parseN8n } from './adapters/n8n.js';
import { isMakeBlueprint, parseMake } from './adapters/make.js';

/** The shape `analyze()` returns, stamped as `AnalysisResult.schemaVersion`. */
export const SCHEMA_VERSION = 1;

class UnknownFormatError extends Error {
  constructor() {
    super(
      'That does not look like an n8n workflow or a Make blueprint. Export from n8n with "Download" or from Make with "Export Blueprint", then paste the whole file.',
    );
    this.name = 'UnknownFormatError';
  }
}

function parseWorkflow(input: string | object): Workflow {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  if (isN8nWorkflow(raw)) return parseN8n(raw);
  if (isMakeBlueprint(raw)) return parseMake(raw);
  throw new UnknownFormatError();
}

/** Order matters: this is what the user reads top to bottom. */
const CHECKS: Array<(wf: Workflow) => Finding[]> = [
  checkZeroWrite,
  checkCredentialExpiry,
  checkCadence,
  checkErrorHandling,
];

export function analyze(input: string | object): AnalysisResult {
  const wf = parseWorkflow(input);
  const findings = CHECKS.flatMap((c) => c(wf)).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return {
    platform: wf.platform,
    workflowName: wf.name,
    nodeCount: wf.nodes.filter((n) => n.role !== 'note' && !n.disabled).length,
    findings,
    protections: checkProtections(wf),
    parseNotes: wf.parseNotes,
    schemaVersion: SCHEMA_VERSION,
    stats: {
      writeNodes: wf.nodes.filter((n) => n.role === 'write' && !n.disabled).length,
      oauthCredentials: wf.nodes
        .flatMap((n) => n.credentials)
        .filter((c) => c.authKind === 'oauth2').length,
      triggers: wf.triggerIds.length,
      staticKeyCredentials: wf.nodes
        .flatMap((n) => n.credentials)
        .filter((c) => c.authKind === 'api-key' || c.authKind === 'basic').length,
    },
  };
}

/** One step of a workflow as `classifyNodes()` sees it. */
export interface ClassifiedNode {
  /** n8n: the node's `id` (its `name` when the export has no id). Make: the module's id. */
  id: string;
  /**
   * The step's name. For n8n this is the node's `name`, which is also the key
   * n8n uses for the node in `connections` and in an execution's run data.
   */
  label: string;
  /**
   * What the step does. `'write'` is a data write, the same set the zero-write
   * check reasons about: a message sent only on a false, else or error branch
   * is reported as `'alert'` instead, because it tells a human about an empty
   * run rather than writing data.
   */
  role: NodeRole;
  disabled: boolean;
  /**
   * Enabled, not a note, and nothing enabled runs after it except through an
   * error route. Where a run's data ends up when the workflow has no write step.
   * A disabled step in between passes its input straight on, so it doesn't end
   * the path.
   */
  terminal: boolean;
  /**
   * The connections this step uses, each with the `PROVIDERS` entry it
   * matched (`providerId`, `null` when the table doesn't know it). Since 2.3.0.
   */
  credentials: CredentialRef[];
}

/**
 * The role of every step in a workflow, from the same parse and the same
 * classification tables `analyze()` uses. Lets a consumer that watches real
 * runs (stillrunning-api counts the items a run wrote) tell write steps apart
 * without keeping its own copy of those tables. Throws on input `analyze()`
 * would reject.
 */
export function classifyNodes(input: string | object): ClassifiedNode[] {
  const wf = parseWorkflow(input);
  const alertIds = findAlertNodes(wf);
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const next = new Map<string, string[]>();
  for (const e of wf.edges) {
    if (e.channel === 'error') continue;
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  }

  const leadsOn = (id: string, seen: Set<string>): boolean =>
    (next.get(id) ?? []).some((to) => {
      const n = byId.get(to);
      if (!n || n.role === 'note' || seen.has(to)) return false;
      if (!n.disabled) return true;
      seen.add(to);
      return leadsOn(to, seen);
    });

  return wf.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    role: n.role === 'write' && alertIds.has(n.id) ? 'alert' : n.role,
    disabled: n.disabled,
    terminal: !n.disabled && n.role !== 'note' && !leadsOn(n.id, new Set([n.id])),
    credentials: n.credentials.map((c) => ({ ...c })),
  }));
}

/**
 * The provider expiry table the credential-expiry check reads, and the match
 * that maps a raw credential type onto it. For consumers that see a real
 * credential fail and want to say what that provider's tokens usually do
 * (stillrunning-api). Frozen: analyze() reads the same objects.
 */
export { PROVIDERS, resolveProvider } from './core/providers.js';
export type { ExpiryRule, Provider } from './core/providers.js';

export type {
  AuthKind,
  CredentialRef,
  Finding,
  NodeRole,
  Platform,
  Severity,
} from './core/model.js';
