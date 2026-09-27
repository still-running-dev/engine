import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyNodes } from '../src/index.js';
import { wf, node, search, write, iff, hourlyTrig, link, merge } from './helpers.js';

const slack = (name: string) => node(name, 'n8n-nodes-base.slack');
const set = (name: string) => node(name, 'n8n-nodes-base.set');
const byLabel = (nodes: ReturnType<typeof classifyNodes>) =>
  Object.fromEntries(nodes.map((n) => [n.label, n]));

describe('classifyNodes', () => {
  it('returns every step with the role analyze() reasons about', () => {
    const nodes = classifyNodes(
      wf('t', [hourlyTrig('Tick'), search('Find'), iff('Any?'), write('Save'), node('Note', 'n8n-nodes-base.stickyNote')],
        merge(link('Tick', 'Find'), link('Find', 'Any?'), link('Any?', 'Save', 0))),
    );

    expect(nodes.map((n) => [n.label, n.role])).toEqual([
      ['Tick', 'trigger'],
      ['Find', 'read'],
      ['Any?', 'gate'],
      ['Save', 'write'],
      ['Note', 'note'],
    ]);
  });

  it('reports a message sent on the false branch as an alert, not a write', () => {
    const nodes = byLabel(
      classifyNodes(
        wf('t', [hourlyTrig('Tick'), iff('Any?'), write('Save'), slack('Tell someone')],
          merge(link('Tick', 'Any?'), link('Any?', 'Save', 0), link('Any?', 'Tell someone', 1))),
      ),
    );

    expect(nodes['Save'].role).toBe('write');
    expect(nodes['Tell someone'].role).toBe('alert');
  });

  it('keeps a message on the happy path as a write', () => {
    const nodes = byLabel(
      classifyNodes(wf('t', [hourlyTrig('Tick'), slack('Post')], link('Tick', 'Post'))),
    );

    expect(nodes['Post'].role).toBe('write');
  });

  it('marks the steps nothing runs after as terminal', () => {
    const nodes = byLabel(
      classifyNodes(
        wf('t', [hourlyTrig('Tick'), iff('Any?'), set('Shape'), write('Save'), set('Nothing to do')],
          merge(link('Tick', 'Any?'), link('Any?', 'Shape', 0), link('Shape', 'Save'), link('Any?', 'Nothing to do', 1))),
      ),
    );

    expect(Object.values(nodes).filter((n) => n.terminal).map((n) => n.label).sort())
      .toEqual(['Nothing to do', 'Save']);
  });

  it('looks through a disabled step, which passes its input straight on', () => {
    const nodes = byLabel(
      classifyNodes(
        wf('t', [hourlyTrig('Tick'), set('Shape'), set('Paused'), write('Save')].map((n) =>
          n.name === 'Paused' ? { ...n, disabled: true } : n),
          merge(link('Tick', 'Shape'), link('Shape', 'Paused'), link('Paused', 'Save'))),
      ),
    );

    expect(nodes['Shape'].terminal).toBe(false);
    expect(nodes['Paused']).toMatchObject({ disabled: true, terminal: false });
    expect(nodes['Save'].terminal).toBe(true);
  });

  it('reads the n8n error output of a write step as an error route', () => {
    const raw = wf('t', [hourlyTrig('Tick'), write('Save'), slack('Append failed')], link('Tick', 'Save'));
    raw.nodes[1].onError = 'continueErrorOutput';
    raw.connections['Save'] = { main: [[], [{ node: 'Append failed', type: 'main', index: 0 }]] };

    const nodes = byLabel(classifyNodes(raw));
    // A message about failed writes is an alert, not more data written.
    expect(nodes['Append failed'].role).toBe('alert');
    expect(nodes['Save'].terminal).toBe(true);
  });

  it('puts the error output of an IF after its true and false outputs', () => {
    const raw = wf('t', [hourlyTrig('Tick'), iff('Any?'), write('Save'), slack('Broke')],
      merge(link('Tick', 'Any?'), link('Any?', 'Save', 0)));
    raw.nodes[1].onError = 'continueErrorOutput';
    raw.connections['Any?'].main[1] = [];
    raw.connections['Any?'].main[2] = [{ node: 'Broke', type: 'main', index: 0 }];

    const nodes = byLabel(classifyNodes(raw));
    expect(nodes['Broke'].role).toBe('alert');
    expect(nodes['Save'].role).toBe('write');
  });

  it('leaves outputs alone when it cannot tell which one is the error output', () => {
    const raw = wf('t', [hourlyTrig('Tick'), node('Route', 'n8n-nodes-base.switch'), write('A'), write('B')],
      merge(link('Tick', 'Route'), link('Route', 'A', 0), link('Route', 'B', 1)));
    raw.nodes[1].onError = 'continueErrorOutput';

    const nodes = byLabel(classifyNodes(raw));
    expect(nodes['A'].role).toBe('write');
    expect(nodes['B'].role).toBe('write');
  });

  it('keys n8n steps by the node name, which is what run data uses', () => {
    const raw = wf('t', [{ ...write('Save'), id: '6b1f0c2e-uuid' }]);
    expect(classifyNodes(raw)[0]).toMatchObject({ id: '6b1f0c2e-uuid', label: 'Save' });
  });

  it('accepts a JSON string, like analyze()', () => {
    const raw = wf('t', [hourlyTrig('Tick'), write('Save')], link('Tick', 'Save'));
    expect(classifyNodes(JSON.stringify(raw))).toEqual(classifyNodes(raw));
  });

  it('classifies a Make blueprint', () => {
    const raw = readFileSync(new URL('./fixtures/make-sheets-openai.json', import.meta.url), 'utf8');
    const nodes = classifyNodes(raw);

    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.some((n) => n.role === 'write')).toBe(true);
    expect(nodes.some((n) => n.terminal)).toBe(true);
  });

  it('throws on input analyze() would reject', () => {
    expect(() => classifyNodes({ hello: 'world' })).toThrow(/does not look like/);
  });
});
