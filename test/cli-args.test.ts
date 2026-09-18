import { describe, it, expect } from 'vitest';
import { CliUsageError, parseCliArgs } from '../src/cli/args.js';

describe('parseCliArgs', () => {
  it('parses a bare path with no flags', () => {
    const opts = parseCliArgs(['./workflow.json']);
    expect(opts).toEqual({
      path: './workflow.json',
      json: false,
      minSeverity: null,
      failOn: null,
      version: false,
      verify: false,
      help: false,
    });
  });

  it('parses every flag together', () => {
    const opts = parseCliArgs(['./dir', '--json', '--min-severity=high', '--fail-on=critical']);
    expect(opts.path).toBe('./dir');
    expect(opts.json).toBe(true);
    expect(opts.minSeverity).toBe('high');
    expect(opts.failOn).toBe('critical');
  });

  it('parses --version and --verify with no path', () => {
    const opts = parseCliArgs(['--version', '--verify']);
    expect(opts.path).toBeNull();
    expect(opts.version).toBe(true);
    expect(opts.verify).toBe(true);
  });

  it('rejects an unknown severity on --min-severity', () => {
    expect(() => parseCliArgs(['./x.json', '--min-severity=disastrous'])).toThrow(CliUsageError);
  });

  it('rejects an unknown severity on --fail-on', () => {
    expect(() => parseCliArgs(['./x.json', '--fail-on=whoops'])).toThrow(CliUsageError);
  });

  it('rejects more than one positional', () => {
    expect(() => parseCliArgs(['a.json', 'b.json'])).toThrow(CliUsageError);
  });

  it('rejects an unrecognised flag', () => {
    expect(() => parseCliArgs(['a.json', '--not-a-real-flag'])).toThrow(CliUsageError);
  });
});
