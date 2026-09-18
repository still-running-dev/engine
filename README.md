# engine

The analysis engine behind stillrunning.dev. Published as
@still-running/health-check.

You paste an n8n workflow export or a Make blueprint export, and this tells
you which of its steps can finish "successful" while quietly doing nothing —
no error, no red X, no execution flagged. Automations don't usually break
loudly. They break by going quiet, and the platform's own execution log
looks identical either way.

This is static analysis of the exported JSON. It never runs your workflow,
never calls your APIs, and never sees your credentials — it reads the graph
shape and the node settings, nothing else. No network call, no storage, all
of it can run in a browser tab.

## A worked example

Take this three-step n8n workflow: a manual trigger, an Airtable search for
an existing contact, then an Airtable "create" to add it if not found.

```json
{
  "id": "1",
  "active": true,
  "name": "New lead to CRM",
  "nodes": [
    { "id": "Start", "name": "Start", "type": "n8n-nodes-base.manualTrigger", "parameters": {} },
    { "id": "Find existing contact", "name": "Find existing contact", "type": "n8n-nodes-base.airtable", "parameters": { "operation": "search" } },
    { "id": "Create in CRM", "name": "Create in CRM", "type": "n8n-nodes-base.airtable", "parameters": { "operation": "create" } }
  ],
  "connections": {
    "Start": { "main": [[{ "node": "Find existing contact", "type": "main", "index": 0 }]] },
    "Find existing contact": { "main": [[{ "node": "Create in CRM", "type": "main", "index": 0 }]] }
  },
  "settings": {}
}
```

`analyze()` on that input returns:

```json
{
  "platform": "n8n",
  "workflowName": "New lead to CRM",
  "nodeCount": 3,
  "findings": [
    {
      "checkId": "zero-write",
      "severity": "critical",
      "nodeId": "Create in CRM",
      "nodeLabel": "Create in CRM",
      "title": "\"Create in CRM\" can be skipped entirely and the run still finishes green",
      "ifItGoesQuiet": "\"Find existing contact\" can find no matching records. Every path to \"Create in CRM\" goes through it, so nothing is written to Airtable, every step shows as successful, and the execution list looks exactly like a normal day. This is the only write in the workflow, so the run does nothing at all.",
      "detail": "Chain: \"Find existing contact\" -> \"Create in CRM\". Nothing else leaves that step, so the empty case reaches nobody.",
      "howToCheck": "Nothing in this workflow would surface an empty run: no alert branch, no expected rhythm, no error handler. Static analysis can only tell you this is possible. Whether it is happening needs run history: compare items written per run against the same run a week ago."
    }
  ],
  "schemaVersion": 1
}
```

(Three more findings — no workflow-level error handler, no declared schedule,
no retries on either node — come back too; trimmed here for the one that
matters.)

**The route through the graph that skips the write:** `Create in CRM` has
exactly one path to it, and that path passes through `Find existing
contact`. A search that matches nothing returns zero items — that's not a
bug, it's what "search" means — and n8n stops there: nothing downstream
runs, and the execution still shows as a success. `Find existing contact`
*dominates* `Create in CRM` (every path from the trigger passes through it),
it can structurally emit zero rows, and nothing else leaves that node to
catch the empty case — no alert, no error branch, no other output. So this
is the workflow's only write, gated by the workflow's only search, with
nobody told either way. That combination is what makes it `critical`
instead of merely worth knowing.

Change the graph — add a second path to `Create in CRM`, or an alert off the
`false` branch, or a declared schedule — and the same check lowers the
severity or drops the finding, because the run stops being silent. That's
computed with dominator analysis, not path enumeration: a 246-node workflow
has too many paths to walk by hand, and a gate only truly starves a write
when there's no way around it — which is exactly what "dominates" means.

## What it checks, in order

1. **zero-write** — the check above: writes a run can skip while still
   reporting success.
2. **credential-expiry** — flagged as a conditional against a small table of
   real provider expiry windows, never as a predicted date. A static export
   cannot see the consent screen behind a connection.
3. **no-cadence** — nothing in the export declares how often this should
   run, so nobody can tell "idle" from "dead."
4. **error-handling** — no retry, no error branch, no workflow-level
   handler. Table stakes; several free auditors already check this one.

## Known limits — read before trusting a result

- **"Can", never "did."** This is the load-bearing distinction. Static JSON
  cannot tell you a workflow wrote nothing yesterday — only that it could,
  silently, and that nobody would know if it did. Whether it's actually
  happening needs run history, which is a different product than a parser.
- **A trigger returning zero rows is not itself flagged.** A scheduled
  scenario that finds nothing new today is normal. Static analysis can't
  tell "nothing new" from "the source got renamed" — that needs a volume
  baseline over time, deliberately out of scope here.
- **Credential expiry is unknowable from an export.** The file names the
  connection, never the consent screen behind it.
- **Make templates published without connections, and blueprints pulled
  from the API without a schedule, are reported as exactly that** — a
  limit of the export, not a clean bill of health.
- **A Code node is opaque.** Marked "possible," never "structural," and
  never drives a critical or high severity by itself.

## Install

```
npm install @still-running/health-check
```

```ts
import { analyze } from '@still-running/health-check';

const result = analyze(workflowExportJson);
```

The public API is exactly `analyze()`, the `Finding` and `Severity` types,
the `Platform` type, and `SCHEMA_VERSION` — see `CHANGELOG.md` for what
changed at `2.0.0`. `analyze()`'s return carries `schemaVersion`, so anyone
storing results can tell which shape they were written under.

## Command line

```
npx @still-running/health-check ./workflow.json
```

Given the `workflow.json` from the worked example above:

```
workflow.json — New lead to CRM (n8n, 3 nodes)

CRITICAL (1)
  [zero-write] "Create in CRM" can be skipped entirely and the run still finishes green
    node: Create in CRM
    if it goes quiet: "Find existing contact" can find no matching records. Every path to "Create in CRM" goes through it, so nothing is written to Airtable, every step shows as successful, and the execution list looks exactly like a normal day. This is the only write in the workflow, so the run does nothing at all.
    Chain: "Find existing contact" -> "Create in CRM". Nothing else leaves that step, so the empty case reaches nobody.
    how to check: Nothing in this workflow would surface an empty run: no alert branch, no expected rhythm, no error handler. Static analysis can only tell you this is possible. Whether it is happening needs run history: compare items written per run against the same run a week ago.

MEDIUM (1)
  [error-handling] No workflow-level error handler is set
    if it goes quiet: A step that throws stops the run. Somebody has to be watching the execution list to find out.
    This is a different miss from "a node has no error branch", and easier to overlook, because the canvas looks fine. It lives in workflow Settings -> Error Workflow.

LOW (2)
  [no-cadence] This workflow only runs when somebody presses the button
    node: Start
    if it goes quiet: Nothing to detect — a manual workflow that never runs is not broken.
    Nothing to monitor here until it gets a schedule or a webhook.

  [error-handling] 2 steps with no retry and no error branch
    node: Find existing contact
    if it goes quiet: These throw on a bad day and the run stops where it stands, part-done.
    "Find existing contact", "Create in CRM". This is the check every free auditor already does — it is here for completeness, not because it is the interesting part.
```

---

Built by Ali Alsamraay. [stillrunning.dev](https://stillrunning.dev)
