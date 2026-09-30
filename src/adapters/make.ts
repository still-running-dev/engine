/**
 * Make adapter. All Make knowledge lives here.
 *
 * Make differs from n8n in three ways that matter, and all three are absorbed
 * here so the checks never learn about them:
 *  1. The flow is a nested tree (routes, branches, onerror), not a flat node
 *     list plus a connections map. We flatten it and synthesise the edges.
 *  2. Filters sit on the LINK, not in a module. They become edge gates.
 *  3. Scheduling sits outside the blueprint, next to it. Present in a template
 *     export and in the API's whole response, absent from a bare blueprint —
 *     so we say which we got.
 */

import type {
  Cadence,
  CredentialRef,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  NodeRole,
  WriteKind,
  ZeroEmit,
} from '../core/model.js';
import { guessAuthKind, resolveProvider } from '../core/providers.js';

const WRITE_VERBS: Array<[RegExp, WriteKind]> = [
  [/:add(row|record|item)?/i, 'append'],
  [/:create/i, 'create'],
  [/:update/i, 'update'],
  [/:upsert|:addupdate/i, 'upsert'],
  [/:delete|:remove/i, 'delete'],
  [/:send|:createmessage|:createatweet|:createpost|:post/i, 'send'],
  [/:uploadfile|:upload/i, 'create'],
];

const EMPTY_READ = /:(search|list|get[a-z]*|retrieve|watch[a-z]*|iterate)/i;

function moduleApp(module: string): string {
  return (module.split(':')[0] ?? module).replace(/-/g, ' ');
}

/** 'google-sheets:addRow' -> 'Add Row (google sheets)'. Modules are often unnamed. */
function prettyLabel(module: string): string {
  const [app, action] = module.split(':');
  if (!action) return module;
  const words = action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
  return `${words} (${(app ?? '').replace(/-/g, ' ')})`;
}

function classify(m: any): { role: NodeRole; writeKind?: WriteKind; writeTarget?: string; zeroEmit: ZeroEmit | null } {
  const module: string = String(m.module ?? '');
  const lower = module.toLowerCase();

  if (/^builtin:basicrouter/i.test(module)) {
    return {
      role: 'gate',
      zeroEmit: { cause: 'Every route out of this router can filter everything out.', certainty: 'possible' },
    };
  }
  if (/^builtin:basicifelse/i.test(module)) {
    return { role: 'gate', zeroEmit: { cause: 'The condition can be false for every bundle.', certainty: 'structural' } };
  }
  if (/^builtin:basicfeeder|:iterate/i.test(module)) {
    return { role: 'loop', zeroEmit: { cause: 'The array being iterated can be empty, so nothing downstream runs.', certainty: 'structural' } };
  }
  if (/^builtin:basicaggregator|:aggregate/i.test(module)) return { role: 'transform', zeroEmit: null };

  // A watch* module at the head of a flow is the trigger.
  if (/^[a-z0-9-]+:watch/i.test(module) || /gateway:customwebhook/i.test(module)) {
    return { role: 'trigger', zeroEmit: null };
  }

  for (const [re, kind] of WRITE_VERBS) {
    if (re.test(lower)) {
      return { role: 'write', writeKind: kind, writeTarget: moduleApp(module), zeroEmit: null };
    }
  }

  if (EMPTY_READ.test(lower)) {
    return {
      role: 'read',
      zeroEmit: { cause: `The ${moduleApp(module)} search can return no bundles.`, certainty: 'structural' },
    };
  }

  return { role: 'other', zeroEmit: null };
}

/** Connections hide in two places depending on how the blueprint was produced. */
function readConnections(m: any): CredentialRef[] {
  const out: CredentialRef[] = [];
  const restore = m?.metadata?.restore?.parameters?.__IMTCONN__;
  if (restore) {
    const slug = restore?.data?.connection;
    const rawType = slug ? `account:${slug}` : 'account:unknown';
    out.push({
      rawType,
      providerId: resolveProvider(rawType, 'make')?.id ?? null,
      authKind: guessAuthKind(rawType),
      label: typeof restore.label === 'string' ? restore.label : undefined,
    });
  }
  for (const p of m?.metadata?.parameters ?? []) {
    if (p?.name === '__IMTCONN__' && typeof p.type === 'string') {
      if (out.some((c) => c.rawType === p.type)) continue;
      out.push({
        rawType: p.type,
        providerId: resolveProvider(p.type, 'make')?.id ?? null,
        authKind: guessAuthKind(p.type),
      });
    }
  }
  return out;
}

interface Flat {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

/** Walk the nested flow, emitting nodes and the edges implied by sequence. */
function flatten(flow: any[], prevId: string | null, acc: Flat, channel = 'main'): string | null {
  let last = prevId;
  for (const m of flow ?? []) {
    const id = String(m.id ?? `${acc.nodes.length}`);
    const c = classify(m);
    const label = m?.metadata?.designer?.name || prettyLabel(String(m.module ?? id));

    acc.nodes.push({
      id,
      label,
      platformType: String(m.module ?? ''),
      role: c.role,
      writeKind: c.writeKind,
      writeTarget: c.writeTarget,
      zeroEmit: c.zeroEmit,
      credentials: readConnections(m),
      errorHandling: {
        hasErrorBranch: Array.isArray(m.onerror) && m.onerror.length > 0,
        retries: false,
        continueOnFail: false,
        alwaysOutputData: false,
      },
      disabled: m.disabled === true,
    });

    if (last) {
      acc.edges.push({
        from: last,
        to: id,
        channel,
        gate: m.filter
          ? {
              label: String(m.filter.name ?? 'filter'),
              cause: `The filter "${m.filter.name ?? 'unnamed'}" can match nothing.`,
            }
          : null,
      });
      channel = 'main';
    }

    for (const route of m.routes ?? []) {
      flatten(route.flow ?? [], id, acc, 'route');
    }
    for (const branch of m.branches ?? []) {
      flatten(branch.flow ?? [], id, acc, branch.type === 'else' ? 'else' : 'branch');
    }
    for (const handler of m.onerror ?? []) {
      const hFlow = Array.isArray(handler?.flow) ? handler.flow : [handler];
      flatten(hFlow, id, acc, 'error');
    }

    // A router or if/else hands off through its branches, not in sequence.
    if ((m.routes ?? []).length || (m.branches ?? []).length) last = null;
    else last = id;
  }
  return last;
}

/**
 * Make's API answers GET /scenarios/{id}/blueprint one level down:
 * `{ code, response: { blueprint, scheduling } }`. Taken as it comes, so a
 * caller can pass that body without unwrapping it, and keeps its schedule.
 */
function unwrapApiResponse(raw: any): any {
  const inner = raw?.response;
  return inner && typeof inner === 'object' && Array.isArray(inner.blueprint?.flow) ? inner : raw;
}

export function isMakeBlueprint(input: any): boolean {
  if (!input || typeof input !== 'object') return false;
  const raw = unwrapApiResponse(input);
  if (Array.isArray(raw.flow)) return true;
  if (raw.blueprint && Array.isArray(raw.blueprint.flow)) return true;
  return false;
}

export function parseMake(input: any): Workflow {
  const raw = unwrapApiResponse(input);
  const bp = raw.blueprint ?? raw;
  const parseNotes: string[] = [];
  const acc: Flat = { nodes: [], edges: [] };
  flatten(bp.flow ?? [], null, acc);

  const scenarioMeta = bp?.metadata?.scenario ?? {};
  const scheduling = raw.scheduling ?? bp.scheduling ?? null;

  let cadence: Cadence;
  if (scheduling && typeof scheduling.interval === 'number') {
    cadence = {
      kind: 'schedule',
      description:
        scheduling.interval >= 3600
          ? `every ${Math.round(scheduling.interval / 3600)} hour${scheduling.interval >= 7200 ? 's' : ''}`
          : `every ${Math.round(scheduling.interval / 60)} minute${scheduling.interval >= 120 ? 's' : ''}`,
      intervalSeconds: scheduling.interval,
      expectedIntervalKnown: true,
    };
  } else if (bp?.metadata?.instant === true) {
    cadence = { kind: 'event', description: 'an instant trigger (webhook)', intervalSeconds: null, expectedIntervalKnown: false };
  } else {
    cadence = { kind: 'unknown', description: 'no scheduling in this export', intervalSeconds: null, expectedIntervalKnown: false };
    parseNotes.push(
      'This blueprint carries no scheduling block. Blueprints fetched from the Make API contain the flow only — the schedule lives on the scenario. Export from the scenario menu to include it.',
    );
  }

  const withConnections = acc.nodes.filter((n) => n.credentials.length > 0).length;
  if (acc.nodes.length > 0 && withConnections === 0) {
    parseNotes.push(
      'No connection data in this blueprint, so the credential check found nothing to look at. Published templates have connections stripped out; your own scenario export will have them.',
    );
  }

  const triggerIds = acc.nodes.filter((n) => n.role === 'trigger').map((n) => n.id);
  if (triggerIds.length === 0 && acc.nodes.length > 0) triggerIds.push(acc.nodes[0].id);

  return {
    platform: 'make',
    name: String(raw.name ?? bp.name ?? 'Untitled scenario'),
    nodes: acc.nodes,
    edges: acc.edges,
    triggerIds,
    cadence,
    errorPolicy: {
      workflowLevelHandler: acc.nodes.some((n) => n.errorHandling.hasErrorBranch),
      storesFailedRuns: typeof scenarioMeta.dlq === 'boolean' ? scenarioMeta.dlq : null,
      maxErrors: typeof scenarioMeta.maxErrors === 'number' ? scenarioMeta.maxErrors : null,
      notes: [],
    },
    parseNotes,
  };
}
