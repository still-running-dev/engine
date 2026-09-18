import { describe, it, expect } from 'vitest';
import type { AnalysisResult, Finding } from '../src/core/model.js';
import { anyMeetsSeverity, colorEnabled, filterFindings, meetsSeverity, toJsonOutput } from '../src/cli/format.js';
import type { FileOutcome } from '../src/cli/collect.js';

const finding = (severity: Finding['severity'], overrides: Partial<Finding> = {}): Finding => ({
  checkId: 'zero-write',
  severity,
  nodeId: 'N1',
  nodeLabel: 'Save',
  title: 'title',
  ifItGoesQuiet: 'quiet',
  detail: 'Chain: "Find" -> "Save".',
  ...overrides,
});

const analysis = (findings: Finding[]): AnalysisResult => ({
  platform: 'n8n',
  workflowName: 'wf',
  nodeCount: 2,
  findings,
  protections: [],
  parseNotes: [],
  schemaVersion: 1,
  stats: { writeNodes: 1, oauthCredentials: 0, triggers: 1, staticKeyCredentials: 0 },
});

describe('meetsSeverity', () => {
  it('critical meets every threshold', () => {
    expect(meetsSeverity('critical', 'info')).toBe(true);
    expect(meetsSeverity('critical', 'critical')).toBe(true);
  });

  it('info only meets the info threshold', () => {
    expect(meetsSeverity('info', 'high')).toBe(false);
    expect(meetsSeverity('info', 'info')).toBe(true);
  });
});

describe('filterFindings', () => {
  it('passes everything through when minSeverity is null', () => {
    const findings = [finding('low'), finding('critical')];
    expect(filterFindings(findings, null)).toHaveLength(2);
  });

  it('keeps only findings at or above the threshold', () => {
    const findings = [finding('critical'), finding('medium'), finding('low')];
    expect(filterFindings(findings, 'medium').map((f) => f.severity)).toEqual(['critical', 'medium']);
  });
});

describe('anyMeetsSeverity', () => {
  const outcomes: FileOutcome[] = [
    { file: 'a.json', ok: true, result: analysis([finding('low')]) },
    { file: 'b.json', ok: false, error: 'broken' },
  ];

  it('is false when nothing reaches the threshold', () => {
    expect(anyMeetsSeverity(outcomes, 'critical')).toBe(false);
  });

  it('is true when a finding reaches the threshold, regardless of display filtering', () => {
    expect(anyMeetsSeverity(outcomes, 'low')).toBe(true);
  });

  it('ignores files that failed to parse rather than throwing', () => {
    expect(() => anyMeetsSeverity(outcomes, 'info')).not.toThrow();
  });
});

describe('colorEnabled', () => {
  it('is on only when stdout is a TTY and NO_COLOR is absent', () => {
    expect(colorEnabled({}, true)).toBe(true);
    expect(colorEnabled({}, false)).toBe(false);
  });

  it('NO_COLOR disables colour even when set to an empty string', () => {
    expect(colorEnabled({ NO_COLOR: '' }, true)).toBe(false);
    expect(colorEnabled({ NO_COLOR: '1' }, true)).toBe(false);
  });
});

describe('toJsonOutput', () => {
  it('documents ok and failed files in the same results array', () => {
    const outcomes: FileOutcome[] = [
      { file: 'ok.json', ok: true, result: analysis([finding('critical'), finding('low')]) },
      { file: 'bad.json', ok: false, error: 'Unexpected token' },
    ];

    const out = toJsonOutput(outcomes, { schemaVersion: 1, cliVersion: '2.1.0', minSeverity: null });

    expect(out.schemaVersion).toBe(1);
    expect(out.cliVersion).toBe('2.1.0');
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ file: 'ok.json', ok: true, workflowName: 'wf' });
    expect(out.results[1]).toEqual({ file: 'bad.json', ok: false, error: 'Unexpected token' });
  });

  it('applies minSeverity to each file’s findings', () => {
    const outcomes: FileOutcome[] = [
      { file: 'ok.json', ok: true, result: analysis([finding('critical'), finding('low')]) },
    ];

    const out = toJsonOutput(outcomes, { schemaVersion: 1, cliVersion: '2.1.0', minSeverity: 'high' });
    const [entry] = out.results;
    expect(entry.ok).toBe(true);
    if (entry.ok) expect(entry.findings.map((f) => f.severity)).toEqual(['critical']);
  });
});
