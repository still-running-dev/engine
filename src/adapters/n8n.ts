/**
 * n8n adapter. All n8n knowledge lives here and nowhere else.
 *
 * Classification tables below were originally ordered against a snapshot of
 * the public template library that was not kept, and will be re-validated
 * against the rebuilt corpus (see scripts/corpus/ once it exists).
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

const TRIGGER_HINTS = [
  'trigger',
  'webhook',
  'cron',
  'interval',
  'formtrigger',
  'chattrigger',
  'localfiletrigger',
];

/** Nodes that produce writes. Keyed by short type; value maps operation -> kind. */
const WRITE_OPS: Record<string, Record<string, WriteKind> | WriteKind> = {
  googleSheets: { append: 'append', update: 'update', appendOrUpdate: 'upsert', delete: 'delete' },
  airtable: { create: 'create', update: 'update', upsert: 'upsert', append: 'append', deleteRecord: 'delete' },
  notion: { create: 'create', update: 'update', append: 'append' },
  supabase: { create: 'create', update: 'update', upsert: 'upsert' },
  mongoDb: { insert: 'create', update: 'update', upsert: 'upsert' },
  redis: { set: 'update' },
  telegram: 'send',
  slack: 'send',
  gmail: { send: 'send', reply: 'send', sendAndWait: 'send' },
  emailSend: 'send',
  whatsApp: 'send',
  discord: 'send',
  twilio: 'send',
  hubspot: { create: 'create', upsert: 'upsert', update: 'update' },
  pipedrive: { create: 'create', update: 'update' },
  salesforce: { create: 'create', upsert: 'upsert', update: 'update' },
  wordpress: { create: 'create', update: 'update' },
  googleDrive: { upload: 'create', createFromText: 'create', copy: 'create' },
  readWriteFile: { write: 'create' },
  googleCalendar: { create: 'create', update: 'update' },
  clickUp: { create: 'create', update: 'update' },
  trello: { create: 'create', update: 'update' },
  monday: { create: 'create', update: 'update' },
  jira: { create: 'create', update: 'update' },
  baserow: { create: 'create', update: 'update' },
  nocoDb: { create: 'create', update: 'update' },
};

const WRITE_TARGETS: Record<string, string> = {
  googleSheets: 'Google Sheets',
  airtable: 'Airtable',
  notion: 'Notion',
  supabase: 'Supabase',
  mongoDb: 'MongoDB',
  postgres: 'Postgres',
  mySql: 'MySQL',
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  slack: 'Slack',
  telegram: 'Telegram',
  gmail: 'Gmail',
  whatsApp: 'WhatsApp',
};

/** Steps whose whole job is to let some items through and stop the rest. */
const STRUCTURAL_GATES: Record<string, string> = {
  filter: 'The filter can match nothing.',
  if: 'The condition can be false for every item.',
  switch: 'Every item can fall through without matching a branch.',
  removeDuplicates: 'Everything can be a duplicate of a previous run, leaving nothing new.',
  limit: 'The limit can resolve to zero items.',
  splitOut: 'The field being split can be an empty list.',
  splitInBatches: 'The list being looped over can be empty, so the loop body never runs.',
  compareDatasets: 'The comparison can find nothing on either side.',
};

/** Reads that legitimately return nothing. Type -> operations that can be empty. */
const EMPTY_READS: Record<string, string[]> = {
  googleSheets: ['read', 'getAll', 'lookup'],
  airtable: ['search', 'list', 'getAll'],
  notion: ['getAll', 'search'],
  gmail: ['getAll', 'get'],
  postgres: ['executeQuery', 'select'],
  mySql: ['executeQuery', 'select'],
  mongoDb: ['find'],
  hubspot: ['getAll', 'search'],
  googleCalendar: ['getAll'],
  googleDrive: ['list', 'search'],
  rssFeedRead: ['*'],
  supabase: ['getAll', 'get'],
};

function shortType(type: string): string {
  return type.split('.').pop() ?? type;
}

function classify(node: any): { role: NodeRole; writeKind?: WriteKind; writeTarget?: string; zeroEmit: ZeroEmit | null } {
  const type: string = node.type ?? '';
  const st = shortType(type);
  const lower = type.toLowerCase();
  const params = node.parameters ?? {};
  const op: string | undefined = typeof params.operation === 'string' ? params.operation : undefined;

  if (st === 'stickyNote') return { role: 'note', zeroEmit: null };
  if (TRIGGER_HINTS.some((h) => lower.includes(h))) return { role: 'trigger', zeroEmit: null };
  if (st === 'stopAndError') return { role: 'error-handler', zeroEmit: null };

  if (STRUCTURAL_GATES[st]) {
    return { role: 'gate', zeroEmit: { cause: STRUCTURAL_GATES[st], certainty: 'structural' } };
  }

  const writeSpec = WRITE_OPS[st];
  if (writeSpec) {
    if (typeof writeSpec === 'string') {
      return { role: 'write', writeKind: writeSpec, writeTarget: WRITE_TARGETS[st] ?? st, zeroEmit: null };
    }
    if (op && writeSpec[op]) {
      return { role: 'write', writeKind: writeSpec[op], writeTarget: WRITE_TARGETS[st] ?? st, zeroEmit: null };
    }
  }

  // Raw SQL: read the verb rather than the operation name.
  if (st === 'postgres' || st === 'mySql') {
    const q = String(params.query ?? '').trim().toLowerCase();
    if (/^(insert|update|upsert|merge|delete)/.test(q)) {
      return { role: 'write', writeKind: 'create', writeTarget: WRITE_TARGETS[st], zeroEmit: null };
    }
    if (/^(select|with)/.test(q) || !q) {
      return { role: 'read', zeroEmit: { cause: 'The query can return no rows.', certainty: 'structural' } };
    }
  }

  if (st === 'httpRequest') {
    const method = String(params.method ?? 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      return { role: 'write', writeKind: 'send', writeTarget: 'an API', zeroEmit: null };
    }
    return {
      role: 'read',
      zeroEmit: { cause: 'The request can come back with an empty list.', certainty: 'possible' },
    };
  }

  const empties = EMPTY_READS[st];
  if (empties && (empties.includes('*') || (op && empties.includes(op)))) {
    return {
      role: 'read',
      zeroEmit: { cause: `"${node.name}" can find no matching records.`, certainty: 'structural' },
    };
  }

  if (st === 'code' || st === 'function' || st === 'functionItem') {
    return {
      role: 'transform',
      zeroEmit: { cause: 'The code step can return an empty list.', certainty: 'possible' },
    };
  }

  return { role: 'other', zeroEmit: null };
}

function readCadence(nodes: any[]): Cadence {
  for (const n of nodes) {
    const st = shortType(n.type ?? '');
    const p = n.parameters ?? {};
    if (st === 'scheduleTrigger') {
      const rule = p.rule?.interval?.[0];
      if (rule) {
        const field = rule.field ?? 'unknown';
        const every = rule.minutesInterval ?? rule.hoursInterval ?? rule.daysInterval ?? 1;
        const secs: Record<string, number> = { minutes: 60, hours: 3600, days: 86400, weeks: 604800 };
        const unit = String(field).replace(/s$/, '');
        const phrase = Number(every) === 1 ? `every ${unit}` : `every ${every} ${unit}s`;
        return {
          kind: 'schedule',
          description: phrase,
          intervalSeconds: (secs[field] ?? 0) * Number(every) || null,
          expectedIntervalKnown: true,
        };
      }
      return { kind: 'schedule', description: 'a schedule with no interval set', intervalSeconds: null, expectedIntervalKnown: false };
    }
    if (st === 'cron') {
      return { kind: 'schedule', description: 'a cron expression', intervalSeconds: null, expectedIntervalKnown: true };
    }
    if (st === 'intervalTrigger') {
      return { kind: 'schedule', description: 'a fixed interval', intervalSeconds: null, expectedIntervalKnown: true };
    }
  }
  for (const n of nodes) {
    const lower = String(n.type ?? '').toLowerCase();
    if (lower.includes('manualtrigger')) {
      return { kind: 'manual', description: 'the Execute Workflow button', intervalSeconds: null, expectedIntervalKnown: false };
    }
    if (lower.includes('webhook') || lower.includes('formtrigger') || lower.includes('chattrigger')) {
      return { kind: 'event', description: 'an incoming call from outside', intervalSeconds: null, expectedIntervalKnown: false };
    }
    if (lower.includes('trigger')) {
      return { kind: 'event', description: `the ${shortType(n.type)} event`, intervalSeconds: null, expectedIntervalKnown: false };
    }
  }
  return { kind: 'unknown', description: 'no trigger found', intervalSeconds: null, expectedIntervalKnown: false };
}

export function isN8nWorkflow(raw: any): boolean {
  return !!raw && typeof raw === 'object' && Array.isArray(raw.nodes) && typeof raw.connections === 'object';
}

export function parseN8n(raw: any): Workflow {
  const rawNodes: any[] = raw.nodes ?? [];
  const parseNotes: string[] = [];

  const nodes: WorkflowNode[] = rawNodes.map((n) => {
    const c = classify(n);
    const credentials: CredentialRef[] = Object.entries(n.credentials ?? {}).map(
      ([rawType, val]: [string, any]) => ({
        rawType,
        providerId: resolveProvider(rawType, 'n8n')?.id ?? null,
        authKind: guessAuthKind(rawType),
        label: typeof val?.name === 'string' ? val.name : undefined,
      }),
    );
    return {
      id: String(n.id ?? n.name),
      label: String(n.name ?? n.id ?? 'unnamed step'),
      platformType: String(n.type ?? ''),
      role: c.role,
      writeKind: c.writeKind,
      writeTarget: c.writeTarget,
      zeroEmit: c.zeroEmit,
      credentials,
      errorHandling: {
        hasErrorBranch: n.onError === 'continueErrorOutput',
        retries: n.retryOnFail === true,
        continueOnFail: n.continueOnFail === true || n.onError === 'continueRegularOutput',
        alwaysOutputData: n.alwaysOutputData === true,
      },
      disabled: n.disabled === true,
    };
  });

  // n8n keys connections by node NAME; the model keys by id. Bridge it.
  const idByName = new Map(rawNodes.map((n) => [String(n.name), String(n.id ?? n.name)]));
  const edges: WorkflowEdge[] = [];
  for (const [sourceName, outputs] of Object.entries<any>(raw.connections ?? {})) {
    const from = idByName.get(sourceName);
    if (!from) continue;
    for (const [channel, groups] of Object.entries<any>(outputs ?? {})) {
      (groups ?? []).forEach((group: any[], outputIndex: number) => {
        (group ?? []).forEach((conn: any) => {
          const to = idByName.get(String(conn?.node));
          if (!to) return;
          const sourceNode = rawNodes.find((n) => String(n.name) === sourceName);
          const isIf = shortType(sourceNode?.type ?? '') === 'if';
          edges.push({
            from,
            to,
            channel:
              channel === 'main' && isIf ? (outputIndex === 0 ? 'true' : 'false') : channel,
            gate: null,
          });
        });
      });
    }
  }

  const triggerIds = nodes.filter((n) => n.role === 'trigger').map((n) => n.id);
  const hasErrorTrigger = rawNodes.some((n) => shortType(n.type ?? '') === 'errorTrigger');
  const settings = raw.settings ?? {};

  if (!raw.id && !raw.versionId) {
    parseNotes.push('This looks like a template export rather than a live workflow export.');
  }

  return {
    platform: 'n8n',
    name: String(raw.name ?? 'Untitled workflow'),
    nodes,
    edges,
    triggerIds,
    cadence: readCadence(rawNodes),
    errorPolicy: {
      workflowLevelHandler: Boolean(settings.errorWorkflow) || hasErrorTrigger,
      storesFailedRuns: null,
      maxErrors: null,
      notes: [],
    },
    parseNotes,
  };
}
