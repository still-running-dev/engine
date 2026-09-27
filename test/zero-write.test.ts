import { describe, it, expect } from 'vitest';
import { analyze } from '../src/index.js';
import { wf, node, search, write, iff, manualTrig, hourlyTrig, link, merge } from './helpers.js';

/** Zero-write findings that name a node (excludes the "N more" roll-up). */
const zw = (r: ReturnType<typeof analyze>) =>
  r.findings.filter((f) => f.checkId === 'zero-write' && f.nodeId);

describe('dominator analysis', () => {
  it('flags a search that dominates the only write', () => {
    const r = analyze(
      wf('t', [manualTrig(), search('Find'), write('Save')],
        merge(link('Start', 'Find'), link('Find', 'Save'))),
    );
    expect(zw(r)).toHaveLength(1);
    expect(zw(r)[0].nodeLabel).toBe('Save');
  });

  it('does NOT flag a write reachable by a path around the gate', () => {
    // Start -> Find -> Save, and Start -> Save. Find no longer dominates Save.
    const r = analyze(
      wf('t', [manualTrig(), search('Find'), write('Save')],
        merge(link('Start', 'Find'), link('Find', 'Save'), link('Start', 'Save'))),
    );
    expect(zw(r)).toHaveLength(0);
  });

  it('flags both writes an IF dominates', () => {
    const r = analyze(
      wf('t', [manualTrig(), iff('If'), write('SaveA'), write('SaveB')],
        merge(link('Start', 'If'), link('If', 'SaveA', 0), link('If', 'SaveB', 1))),
    );
    expect(zw(r).map((f) => f.nodeLabel).sort()).toEqual(['SaveA', 'SaveB']);
  });

  it('survives a cycle without hanging', () => {
    const r = analyze(
      wf('t', [manualTrig(), search('A'), write('B')],
        merge(link('Start', 'A'), link('A', 'B'), link('B', 'A'))),
    );
    expect(Array.isArray(r.findings)).toBe(true);
  });

  it('reports nothing when there are no writes', () => {
    const r = analyze(wf('t', [manualTrig(), search('Find')], link('Start', 'Find')));
    expect(zw(r)).toHaveLength(0);
  });
});

describe('severity depends on whether anything could notice', () => {
  it('no cadence, sole write, no alert = critical', () => {
    const r = analyze(
      wf('t', [manualTrig(), search('Find'), write('Save')],
        merge(link('Start', 'Find'), link('Find', 'Save'))),
    );
    expect(zw(r)[0].severity).toBe('critical');
  });

  it('a declared cadence downgrades it below high', () => {
    const r = analyze(
      wf('t', [hourlyTrig(), search('Find'), write('Save')],
        merge(link('Every hour', 'Find'), link('Find', 'Save'))),
    );
    expect(['medium', 'low']).toContain(zw(r)[0].severity);
  });

  it('treats a Slack message on the false branch as an alert, not a write', () => {
    const r = analyze(
      wf('t', [manualTrig(), iff('If'), write('Save'), node('Tell us', 'n8n-nodes-base.slack')],
        merge(link('Start', 'If'), link('If', 'Save', 0), link('If', 'Tell us', 1))),
    );
    expect(zw(r).map((f) => f.nodeLabel)).not.toContain('Tell us');
    expect(['medium', 'low']).toContain(zw(r)[0].severity);
  });

  it('treats a Slack message on an n8n error output as an alert, not a write', () => {
    const raw = wf('t', [manualTrig(), search('Find'), write('Save'), node('Save failed', 'n8n-nodes-base.slack')],
      merge(link('Start', 'Find'), link('Find', 'Save')));
    raw.nodes[2].onError = 'continueErrorOutput';
    raw.connections['Save'] = { main: [[], [{ node: 'Save failed', type: 'main', index: 0 }]] };

    expect(zw(analyze(raw)).map((f) => f.nodeLabel)).toEqual(['Save']);
  });
});

describe('credential expiry stays conditional', () => {
  it('never predicts a date it cannot know', () => {
    const r = analyze(
      wf('t', [manualTrig(),
        node('Sheet', 'n8n-nodes-base.googleSheets', {
          parameters: { operation: 'append' },
          credentials: { googleSheetsOAuth2Api: { id: '1', name: 'Client Google' } },
        })], link('Start', 'Sheet')),
    );
    const cred = r.findings.find((f) => f.checkId === 'credential-expiry');
    expect(cred).toBeDefined();
    expect(cred!.detail).toContain('cannot read the expiry');
    expect(cred!.howToCheck).toBeTruthy();
    expect(cred!.sources?.length).toBeGreaterThan(0);
  });

  it('raises one finding per provider, not one per node', () => {
    const cred = { googleSheetsOAuth2Api: { id: '1', name: 'G' } };
    const r = analyze(
      wf('t', [manualTrig(),
        node('A', 'n8n-nodes-base.googleSheets', { parameters: { operation: 'append' }, credentials: cred }),
        node('B', 'n8n-nodes-base.googleSheets', { parameters: { operation: 'update' }, credentials: cred })],
        merge(link('Start', 'A'), link('A', 'B'))),
    );
    expect(r.findings.filter((f) => f.checkId === 'credential-expiry')).toHaveLength(1);
  });
});

describe('real exports parse', () => {
  it('reads a Make blueprint through the same entry point', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const p = path.resolve(import.meta.dirname, 'fixtures/make-sheets-openai.json');
    const r = analyze(JSON.parse(fs.readFileSync(p, 'utf8')));
    expect(r.platform).toBe('make');
    expect(r.nodeCount).toBeGreaterThan(0);
  });
});
