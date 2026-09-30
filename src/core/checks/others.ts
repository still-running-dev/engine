/**
 * CHECK 3 — credential expiry risk.
 * CHECK 2 — triggers with no expected cadence.
 * CHECK 1 — error handling. Table stakes: six free tools already do this, so it
 *           is a short footer, never the headline.
 */

import type { Finding, Workflow } from '../model.js';
import { PROVIDERS, resolveProvider } from '../providers.js';

// ---------------------------------------------------------------- check 3

export function checkCredentialExpiry(wf: Workflow): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const node of wf.nodes) {
    if (node.disabled) continue;
    for (const cred of node.credentials) {
      const provider = cred.providerId
        ? PROVIDERS.find((p) => p.id === cred.providerId)
        : resolveProvider(cred.rawType, wf.platform);

      // One finding per provider per workflow, not one per node. An agency with
      // eight Google Sheets nodes has one Google problem, not eight.
      const key = provider ? provider.id : cred.rawType;
      if (seen.has(key)) continue;

      if (provider) {
        seen.add(key);
        const conditional = provider.rules.filter((r) => r.certainty === 'conditional');
        const shortest = provider.rules[0];
        const severity =
          !provider.autoRefreshable ? 'high' : conditional.length > 0 ? 'medium' : 'low';

        findings.push({
          checkId: 'credential-expiry',
          severity,
          nodeId: node.id,
          nodeLabel: node.label,
          title: `${provider.displayName} connection on "${node.label}" — expiry depends on how it was set up`,
          ifItGoesQuiet:
            provider.autoRefreshable
              ? `The token stops refreshing, the trigger stops firing, and there is no failed run to see — because there is no run at all.`
              : `Nothing on ${provider.displayName} refreshes this automatically. When it lapses, someone has to paste in a new token by hand, and until they do the workflow is silent.`,
          detail: [
            `We cannot read the expiry from a pasted workflow — the export names the connection, not the settings behind it. Here is what it depends on:`,
            ...provider.rules.map(
              (r) => `- ${r.condition}: ${r.window}. ${r.detail}`,
            ),
          ].join('\n'),
          howToCheck: (shortest?.howToCheck ?? conditional[0]?.howToCheck) || undefined,
          // A copy: the table is frozen and shared by every call.
          sources: [...provider.sources],
        });
      } else if (cred.authKind === 'oauth2') {
        seen.add(key);
        findings.push({
          checkId: 'credential-expiry',
          severity: 'low',
          nodeId: node.id,
          nodeLabel: node.label,
          title: `"${node.label}" uses an OAuth connection we do not have expiry data for yet`,
          ifItGoesQuiet:
            'If this provider expires refresh tokens on a schedule, the trigger stops and no error is raised.',
          detail: `Connection type: ${cred.rawType}. Not in our provider table yet.`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------- check 2

export function checkCadence(wf: Workflow): Finding[] {
  if (wf.cadence.expectedIntervalKnown) return [];

  const triggers = wf.nodes.filter((n) => wf.triggerIds.includes(n.id) && !n.disabled);

  // No trigger in the file at all — usually a fragment or a sub-workflow. Say
  // that plainly instead of inventing a cadence complaint about nothing.
  if (triggers.length === 0 || wf.cadence.kind === 'unknown') {
    return [
      {
        checkId: 'no-cadence',
        severity: 'info',
        nodeId: null,
        nodeLabel: null,
        title: 'No trigger in this file',
        ifItGoesQuiet:
          'Nothing to say yet — without a trigger there is no expected rhythm to measure against.',
        detail:
          'This is either a fragment, or a sub-workflow called by another one. Paste the workflow that calls it to see how often this is meant to run.',
      },
    ];
  }

  const label = triggers[0]?.label ?? 'the trigger';

  if (wf.cadence.kind === 'manual') {
    return [
      {
        checkId: 'no-cadence',
        severity: 'low',
        nodeId: triggers[0]?.id ?? null,
        nodeLabel: triggers[0]?.label ?? null,
        title: 'This workflow only runs when somebody presses the button',
        ifItGoesQuiet: 'Nothing to detect — a manual workflow that never runs is not broken.',
        detail: 'Nothing to monitor here until it gets a schedule or a webhook.',
      },
    ];
  }

  return [
    {
      checkId: 'no-cadence',
      severity: wf.cadence.kind === 'event' ? 'high' : 'medium',
      nodeId: triggers[0]?.id ?? null,
      nodeLabel: triggers[0]?.label ?? null,
      title: `Nothing here says how often "${label}" should fire`,
      ifItGoesQuiet:
        'There is no expected rhythm to compare against, so an idle workflow and a dead workflow look identical. Nobody can tell you it stopped, because nobody knows what "running normally" looks like.',
      detail:
        wf.cadence.kind === 'event'
          ? `This fires on an outside event (${wf.cadence.description}). If the source stops sending — a renamed field, a revoked webhook, a client who turned something off — the workflow simply never runs. There is no failed execution, because there is no execution.`
          : `Trigger type: ${wf.cadence.description}. Without an expected interval there is no baseline.`,
      howToCheck:
        'Write down the number you would expect on a normal day: runs per day, or rows per run. That single number is what turns silence into an alert.',
    },
  ];
}

// ---------------------------------------------------------------- check 1

export function checkErrorHandling(wf: Workflow): Finding[] {
  const findings: Finding[] = [];
  const live = wf.nodes.filter((n) => !n.disabled && n.role !== 'note');

  const unhandled = live.filter(
    (n) =>
      (n.role === 'write' || n.role === 'read' || n.platformType.includes('httpRequest')) &&
      !n.errorHandling.hasErrorBranch &&
      !n.errorHandling.retries,
  );

  if (!wf.errorPolicy.workflowLevelHandler) {
    findings.push({
      checkId: 'error-handling',
      severity: 'medium',
      nodeId: null,
      nodeLabel: null,
      title: 'No workflow-level error handler is set',
      ifItGoesQuiet:
        'A step that throws stops the run. Somebody has to be watching the execution list to find out.',
      detail:
        wf.platform === 'n8n'
          ? 'This is a different miss from "a node has no error branch", and easier to overlook, because the canvas looks fine. It lives in workflow Settings -> Error Workflow.'
          : 'No error route on the scenario. Make will retry per its own settings and then stop.',
    });
  }

  if (wf.errorPolicy.storesFailedRuns === false) {
    findings.push({
      checkId: 'error-handling',
      severity: 'high',
      nodeId: null,
      nodeLabel: null,
      title: 'Incomplete executions are switched off',
      ifItGoesQuiet:
        'A run that fails part-way is not stored, so there is nothing to resume and nothing to inspect afterwards. The data that run was carrying is gone.',
      detail:
        'Make stores failed runs only when this is on, and it is off by default. Scenario settings -> Allow storing of Incomplete Executions.',
    });
  }

  if (unhandled.length > 0) {
    const names = unhandled.slice(0, 4).map((n) => `"${n.label}"`).join(', ');
    findings.push({
      checkId: 'error-handling',
      severity: 'low',
      nodeId: unhandled[0].id,
      nodeLabel: unhandled[0].label,
      title: `${unhandled.length} step${unhandled.length === 1 ? '' : 's'} with no retry and no error branch`,
      ifItGoesQuiet:
        'These throw on a bad day and the run stops where it stands, part-done.',
      detail: `${names}${unhandled.length > 4 ? `, and ${unhandled.length - 4} more` : ''}. This is the check every free auditor already does — it is here for completeness, not because it is the interesting part.`,
    });
  }

  return findings;
}
