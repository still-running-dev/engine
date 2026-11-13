/**
 * CHECK 4 — write steps that can complete having written zero rows.
 *
 * The question this answers is NOT "did this workflow write nothing" — static
 * JSON can never answer that. It answers "can this workflow finish green having
 * written nothing, and would anyone notice". That is a blind-spot report, not a
 * bug report, and the wording throughout keeps that distinction.
 *
 * Method: for every write node W, find the nodes that DOMINATE it — the steps
 * that every path from a trigger to W must pass through. If any dominator can
 * emit zero items, W is skipped entirely and the run still reports success.
 *
 * Dominators rather than path enumeration, because a 246-node workflow with 40
 * branches has too many paths to walk, and because a gate only truly starves W
 * if there is no alternative path around it. Dominance is exactly that property.
 */

import type { Finding, Workflow, WorkflowNode } from '../model.js';
import { SEVERITY_ORDER } from '../model.js';

/** Iterative dominator computation from a virtual entry over all triggers. */
export function computeDominators(wf: Workflow): Map<string, Set<string>> {
  const ENTRY = '\u0000entry';
  const ids = wf.nodes.filter((n) => !n.disabled).map((n) => n.id);
  const idSet = new Set(ids);

  const preds = new Map<string, string[]>();
  for (const id of ids) preds.set(id, []);
  preds.set(ENTRY, []);

  for (const e of wf.edges) {
    // Error branches are not the normal path; a node reached only via an error
    // branch should not be treated as part of the happy path.
    if (e.channel === 'error') continue;
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    preds.get(e.to)!.push(e.from);
  }
  for (const t of wf.triggerIds) {
    if (idSet.has(t)) preds.get(t)!.push(ENTRY);
  }
  // Nodes with no predecessor at all hang off the entry, otherwise they are
  // unreachable and dominance is undefined for them.
  for (const id of ids) {
    if (preds.get(id)!.length === 0) preds.get(id)!.push(ENTRY);
  }

  const all = new Set([ENTRY, ...ids]);
  const dom = new Map<string, Set<string>>();
  dom.set(ENTRY, new Set([ENTRY]));
  for (const id of ids) dom.set(id, new Set(all));

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    for (const id of ids) {
      const ps = preds.get(id)!;
      let next: Set<string> | null = null;
      for (const p of ps) {
        const dp = dom.get(p);
        if (!dp) continue;
        if (next === null) {
          next = new Set(dp);
        } else {
          for (const x of [...next]) if (!dp.has(x)) next.delete(x);
        }
      }
      if (next === null) next = new Set<string>();
      next.add(id);
      const cur = dom.get(id)!;
      if (next.size !== cur.size || [...next].some((x) => !cur.has(x))) {
        dom.set(id, next);
        changed = true;
      }
    }
  }
  return dom;
}

/**
 * Is the empty case caught? A gate is "guarded" when something else leaves it —
 * an else branch, an error route, an alert. Then somebody at least hears about
 * the empty run. Unguarded means the silence is total.
 */
export function isGuarded(wf: Workflow, gateId: string): boolean {
  const out = wf.edges.filter((e) => e.from === gateId);
  const channels = new Set(out.map((e) => e.channel));
  // More than one live output channel means the empty/false case goes somewhere.
  if (channels.size > 1) return true;
  if (channels.has('error')) return true;
  // A downstream alert node directly off this gate also counts.
  return out.some((e) => {
    const n = wf.nodes.find((x) => x.id === e.to);
    return n?.role === 'alert' || n?.role === 'error-handler';
  });
}

/**
 * A message sent on a false/else/error branch is an alert, not a data write.
 * Distinguishing these is what stops the check flagging every Slack node in
 * every workflow — and it tells us whether the empty case reaches a human.
 */
const ALERT_CHANNELS = new Set(['false', 'else', 'error']);
const ALERT_TARGETS = /slack|telegram|discord|gmail|email|twilio|whatsapp|pushover/i;

export function findAlertNodes(wf: Workflow): Set<string> {
  const alerts = new Set<string>();
  for (const e of wf.edges) {
    if (!ALERT_CHANNELS.has(e.channel)) continue;
    const n = wf.nodes.find((x) => x.id === e.to);
    if (!n) continue;
    if (n.writeKind === 'send' && ALERT_TARGETS.test(n.platformType + ' ' + (n.writeTarget ?? ''))) {
      alerts.add(n.id);
    }
  }
  for (const n of wf.nodes) {
    if (n.role === 'error-handler') alerts.add(n.id);
  }
  return alerts;
}

export function checkZeroWrite(wf: Workflow): Finding[] {
  const findings: Finding[] = [];
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  const alertIds = findAlertNodes(wf);

  // Alerts are not data writes. A skipped alert is a real problem but a
  // different one, and lumping them together is what makes these tools noisy.
  const writes = wf.nodes.filter(
    (n) => n.role === 'write' && !n.disabled && !alertIds.has(n.id),
  );
  if (writes.length === 0) return findings;

  /**
   * Could anything in this workflow notice an empty run? Either somebody gets
   * told, or there is a known rhythm to measure against. If neither, silence is
   * total — and that is the only case worth shouting about.
   */
  const hasSafetyNet =
    alertIds.size > 0 ||
    wf.cadence.expectedIntervalKnown ||
    wf.errorPolicy.workflowLevelHandler;

  const dom = computeDominators(wf);
  const soleWrite = writes.length === 1;

  for (const w of writes) {
    const dominators = dom.get(w.id) ?? new Set<string>();
    const starvers: { node: WorkflowNode; guarded: boolean }[] = [];

    for (const dId of dominators) {
      if (dId === w.id) continue;
      const d = byId.get(dId);
      if (!d || !d.zeroEmit) continue;
      starvers.push({ node: d, guarded: isGuarded(wf, dId) });
    }

    // A gate sitting on an edge (Make puts filters on links, not in modules).
    const gateEdges = wf.edges.filter(
      (e) => e.gate && dominators.has(e.from) && dominators.has(e.to),
    );

    if (starvers.length === 0 && gateEdges.length === 0) {
      // Nothing upstream can starve it. Still worth one quiet note if the write
      // is set to swallow its own failures.
      if (w.errorHandling.continueOnFail) {
        findings.push({
          checkId: 'zero-write',
          severity: 'medium',
          nodeId: w.id,
          nodeLabel: w.label,
          title: `"${w.label}" is set to carry on when it fails`,
          ifItGoesQuiet: `The write fails, the run continues to the end, and the execution is recorded as a success. Nothing writes and nothing is flagged.`,
          detail:
            'Continue-on-fail is the right setting when a later step handles the failure. Nothing downstream of this node looks like it does.',
        });
      }
      continue;
    }

    const unguarded = starvers.filter((s) => !s.guarded);
    const structural = unguarded.filter((s) => s.node.zeroEmit!.certainty === 'structural');
    const worst = structural[0] ?? unguarded[0] ?? starvers[0];
    if (!worst) continue;

    let severity: Finding['severity'];
    if (structural.length > 0 && !hasSafetyNet) {
      // Nothing here could tell you it happened.
      severity = soleWrite ? 'critical' : 'high';
    } else if (structural.length > 0) {
      // Real, but something in the workflow would surface it.
      severity = soleWrite ? 'medium' : 'low';
    } else if (unguarded.length > 0) {
      severity = hasSafetyNet ? 'low' : 'medium';
    } else {
      severity = 'low';
    }

    // Pick the most telling steps (structural first), then print them in the
    // order a run reaches them, which the picking order isn't: B's
    // Code -> Filter -> write used to read "Filter" -> "Code" -> write. A
    // write's dominators lie on one path, so a step with fewer dominators of
    // its own comes earlier on it.
    const picked = [
      ...new Map([...structural, ...unguarded, ...starvers].map((s) => [s.node.id, s.node])).values(),
    ].slice(0, 3);
    const chainNames = picked
      .sort((a, b) => (dom.get(a.id)?.size ?? 0) - (dom.get(b.id)?.size ?? 0))
      .map((n) => `"${n.label}"`)
      .join(' -> ');

    const target = w.writeTarget ? ` to ${w.writeTarget}` : '';

    findings.push({
      checkId: 'zero-write',
      severity,
      nodeId: w.id,
      nodeLabel: w.label,
      title: `"${w.label}" can be skipped entirely and the run still finishes green`,
      ifItGoesQuiet:
        `${worst.node.zeroEmit!.cause} Every path to "${w.label}" goes through it, so nothing is written${target}, ` +
        `every step shows as successful, and the execution list looks exactly like a normal day.` +
        (soleWrite ? ' This is the only write in the workflow, so the run does nothing at all.' : ''),
      detail:
        `Chain: ${chainNames} -> "${w.label}". ` +
        (worst.guarded
          ? 'There is another branch off that step, so the empty case does reach something.'
          : 'Nothing else leaves that step, so the empty case reaches nobody.') +
        (worst.node.errorHandling.alwaysOutputData
          ? ' Note: that step has "always output data" switched on, so it pushes an empty item through rather than stopping — the write may run and write a blank row instead of nothing at all.'
          : ''),
      howToCheck:
        (hasSafetyNet
          ? 'Something in this workflow would surface an empty run, so this is worth knowing rather than worth panicking about. '
          : 'Nothing in this workflow would surface an empty run: no alert branch, no expected rhythm, no error handler. ') +
        'Static analysis can only tell you this is possible. Whether it is happening needs run history: compare items written per run against the same run a week ago.',
    });
  }

  // A 246-node workflow can generate forty of these. Three is a report; forty
  // is wallpaper that gets closed.
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  if (findings.length > 3) {
    const rest = findings.length - 3;
    const top = findings.slice(0, 3);
    top.push({
      checkId: 'zero-write',
      severity: 'info',
      nodeId: null,
      nodeLabel: null,
      title: `${rest} more write step${rest === 1 ? '' : 's'} with the same pattern`,
      ifItGoesQuiet: 'Same story as above, further down the workflow.',
      detail: 'Showing the three that matter most. The rest follow the same shape.',
    });
    return top;
  }

  return findings;
}
