import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyze, classifyNodes, PROVIDERS, resolveProvider } from '../src/index.js';
import { wf, node, manualTrig, link } from './helpers.js';

const DAY = 86_400;

const sheet = (name: string, credentials: Record<string, unknown>) =>
  node(name, 'n8n-nodes-base.googleSheets', { parameters: { operation: 'append' }, credentials });

describe('PROVIDERS', () => {
  it('is exported with every provider the credential check knows', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['google', 'microsoft', 'meta-whatsapp']);
  });

  it('is frozen all the way down, so a consumer cannot change what analyze() reads', () => {
    const google = PROVIDERS.find((p) => p.id === 'google')!;
    expect(Object.isFrozen(PROVIDERS)).toBe(true);
    expect(Object.isFrozen(google)).toBe(true);
    expect(Object.isFrozen(google.rules[0])).toBe(true);
    expect(Object.isFrozen(google.match.n8n)).toBe(true);
    expect(() => {
      (google.rules[0] as { window: string }).window = 'forever';
    }).toThrow(TypeError);
    expect(() => (PROVIDERS as unknown[]).push({})).toThrow(TypeError);
  });

  it('hands findings a copy of the sources, not the table’s own array', () => {
    const r = analyze(wf('t', [manualTrig(), sheet('Sheet', { googleSheetsOAuth2Api: { id: '1', name: 'G' } })],
      link('Start', 'Sheet')));
    const finding = r.findings.find((f) => f.checkId === 'credential-expiry')!;

    finding.sources!.push('https://example.com');
    expect(PROVIDERS.find((p) => p.id === 'google')!.sources).not.toContain('https://example.com');
  });

  it('gives every rule a number exactly when its window has a fixed length', () => {
    for (const p of PROVIDERS) {
      for (const r of p.rules) {
        expect(r.windowSeconds === null, `${p.id}: ${r.window}`).toBe(r.countsFrom === null);
        if (r.windowSeconds !== null) expect(r.windowSeconds).toBeGreaterThan(0);
      }
    }
  });

  it('keeps each number in step with the words the reader sees', () => {
    for (const p of PROVIDERS) {
      for (const r of p.rules) {
        const days = /^(\d+) days/.exec(r.window);
        if (days) expect(r.windowSeconds, `${p.id}: ${r.window}`).toBe(Number(days[1]) * DAY);
        if (/indefinite|never|policy/.test(r.window)) expect(r.windowSeconds).toBeNull();
        if (/inactivity/.test(r.window)) expect(r.countsFrom).toBe('last-use');
      }
    }
  });

  it('counts Google’s testing-mode window from consent', () => {
    const testing = PROVIDERS.find((p) => p.id === 'google')!.rules[0];
    expect(testing).toMatchObject({ window: '7 days', windowSeconds: 7 * DAY, countsFrom: 'issued' });
  });
});

describe('resolveProvider', () => {
  it('maps raw credential types from either platform', () => {
    expect(resolveProvider('googleSheetsOAuth2Api', 'n8n')?.id).toBe('google');
    expect(resolveProvider('microsoftOutlookOAuth2Api', 'n8n')?.id).toBe('microsoft');
    expect(resolveProvider('account:google', 'make')?.id).toBe('google');
    expect(resolveProvider('account:whatsapp', 'make')?.id).toBe('meta-whatsapp');
  });

  it('returns null for a type the table does not know', () => {
    expect(resolveProvider('airtableTokenApi', 'n8n')).toBeNull();
  });

  it('returns the same frozen entry PROVIDERS holds', () => {
    expect(resolveProvider('gmailOAuth2', 'n8n')).toBe(PROVIDERS[0]);
  });
});

describe('classifyNodes credentials', () => {
  it('lists each n8n step’s connections with the provider they matched', () => {
    const nodes = classifyNodes(
      wf('t', [manualTrig(), sheet('Sheet', { googleSheetsOAuth2Api: { id: '1', name: 'Client Google' } }),
        node('Base', 'n8n-nodes-base.airtable', {
          parameters: { operation: 'create' },
          credentials: { airtableTokenApi: { id: '2', name: 'Airtable' } },
        })],
        { ...link('Start', 'Sheet'), ...link('Sheet', 'Base') }),
    );
    const byLabel = Object.fromEntries(nodes.map((n) => [n.label, n]));

    expect(byLabel['Start'].credentials).toEqual([]);
    expect(byLabel['Sheet'].credentials).toEqual([
      { rawType: 'googleSheetsOAuth2Api', providerId: 'google', authKind: 'oauth2', label: 'Client Google' },
    ]);
    expect(byLabel['Base'].credentials).toEqual([
      { rawType: 'airtableTokenApi', providerId: null, authKind: 'api-key', label: 'Airtable' },
    ]);
  });

  it('reads Make connections too', () => {
    const raw = readFileSync(new URL('./fixtures/make-sheets-openai.json', import.meta.url), 'utf8');
    const google = classifyNodes(raw).flatMap((n) => n.credentials).filter((c) => c.providerId === 'google');

    expect(google.length).toBeGreaterThan(0);
    expect(google[0]).toMatchObject({ rawType: 'account:google', providerId: 'google' });
  });
});

describe('Make API response wrapper', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/make-sheets-openai.json', import.meta.url), 'utf8'),
  );
  // What GET /scenarios/{id}/blueprint returns: the scenario one level down.
  const apiBody = {
    code: 'OK',
    response: { blueprint: fixture.blueprint, scheduling: fixture.scheduling, idSequence: 7 },
  };

  it('analyses the body as Make returns it', () => {
    const r = analyze(apiBody);
    expect(r.platform).toBe('make');
    expect(r).toEqual(analyze({ blueprint: fixture.blueprint, scheduling: fixture.scheduling }));
  });

  it('keeps the schedule that comes next to the blueprint', () => {
    const r = analyze(apiBody);
    expect(r.findings.some((f) => f.checkId === 'no-cadence')).toBe(false);
    expect(r.parseNotes.join(' ')).not.toMatch(/no scheduling block/);
  });

  it('classifies it too', () => {
    expect(classifyNodes(apiBody)).toEqual(classifyNodes(fixture));
  });

  it('still rejects a response that holds no blueprint', () => {
    expect(() => analyze({ code: 'OK', response: { scenarios: [] } })).toThrow(/does not look like/);
    expect(() => analyze({ response: { blueprint: { name: 'no flow' } } })).toThrow(/does not look like/);
  });
});
