import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli/run.js';
import { SCHEMA_VERSION } from '../src/index.js';

const FIXTURE = join(__dirname, 'fixtures', 'n8n-airtable-critical.json');
// Stands in for the real `dist/` at runtime: its parent is the repo root,
// which is all `readCliVersion` needs — it does not require dist/ to exist.
const MODULE_DIR = join(process.cwd(), 'dist');

/** Captures what the CLI printed without letting it touch the real console. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => out.push(line));
  const errSpy = vi.spyOn(console, 'error').mockImplementation((line: string) => err.push(line));
  return {
    out,
    err,
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-cli-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('run — single file', () => {
  it('analyses a file, exits 0, and prints findings grouped by severity', () => {
    const c = capture();
    const code = run([FIXTURE], MODULE_DIR);
    c.restore();

    expect(code).toBe(0);
    const printed = c.out.join('\n');
    expect(printed).toContain('CRITICAL');
    // the graph route that skips the write — the whole point of this tool.
    expect(printed).toContain('Chain: "Airtable" -> "Airtable1"');
  });

  it('--min-severity hides less severe findings', () => {
    const c = capture();
    run([FIXTURE, '--min-severity=high'], MODULE_DIR);
    c.restore();

    const printed = c.out.join('\n');
    expect(printed).toContain('CRITICAL');
    expect(printed).not.toContain('LOW');
    expect(printed).not.toContain('INFO');
  });

  it('--fail-on exits non-zero exactly when a finding reaches that severity', () => {
    const c = capture();
    const failed = run([FIXTURE, '--fail-on=critical'], MODULE_DIR);
    const passed = run([FIXTURE, '--fail-on=critical', '--min-severity=critical'], MODULE_DIR);
    c.restore();

    expect(failed).toBe(1);
    expect(passed).toBe(1); // display filtering never changes the exit code
  });

  it('exit code stays 0 by default even though findings exist', () => {
    const c = capture();
    const code = run([FIXTURE], MODULE_DIR);
    c.restore();
    expect(code).toBe(0);
  });

  it('--json emits the documented { schemaVersion, cliVersion, results } shape', () => {
    const c = capture();
    run([FIXTURE, '--json'], MODULE_DIR);
    c.restore();

    const parsed = JSON.parse(c.out.join('\n'));
    expect(parsed).toHaveProperty('schemaVersion', SCHEMA_VERSION);
    expect(parsed).toHaveProperty('cliVersion');
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toMatchObject({ file: FIXTURE, ok: true, platform: 'n8n' });
  });
});

describe('run — directory mode', () => {
  it('walks subdirectories and never aborts on a malformed file', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'broken.json'), '{ not valid json');
    writeFileSync(join(dir, 'sub', 'ok.json'), '{}'); // valid JSON, unrecognised shape

    const c = capture();
    const code = run([dir, '--json'], MODULE_DIR);
    c.restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(c.out.join('\n'));
    expect(parsed.results).toHaveLength(2);

    const broken = parsed.results.find((r: { file: string }) => r.file.endsWith('broken.json'));
    expect(broken.ok).toBe(false);
    expect(typeof broken.error).toBe('string');

    const ok = parsed.results.find((r: { file: string }) => r.file.endsWith('ok.json'));
    // "{}" is valid JSON but not a recognisable workflow — still reported as a
    // failure with a reason, not a crash.
    expect(ok.ok).toBe(false);
    expect(typeof ok.error).toBe('string');
  });
});

describe('run — invalid input', () => {
  it('reports a usage error and exits 2 for a bad flag value', () => {
    const c = capture();
    const code = run([FIXTURE, '--min-severity=nonsense'], MODULE_DIR);
    c.restore();
    expect(code).toBe(2);
    expect(c.err.join('\n')).toMatch(/not a severity/);
  });

  it('exits 2 with no path and no --version/--help', () => {
    const c = capture();
    const code = run([], MODULE_DIR);
    c.restore();
    expect(code).toBe(2);
  });

  it('exits 2 rather than throwing for a path that does not exist', () => {
    const c = capture();
    const code = run([join(tmpdir(), 'does-not-exist-at-all.json')], MODULE_DIR);
    c.restore();
    expect(code).toBe(2);
  });
});

describe('run — --version and --verify', () => {
  /**
   * `moduleDir` stands in for `dist/`: its parent must hold `package.json`
   * (the real layout, since `dist/` sits directly under the repo root), and
   * it holds `index.js` for --verify to hash.
   */
  function makeFakeModuleDir(version: string, indexContent: string | null): string {
    const root = makeTempDir();
    const moduleDir = join(root, 'dist-like');
    mkdirSync(moduleDir);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
    if (indexContent !== null) writeFileSync(join(moduleDir, 'index.js'), indexContent);
    return moduleDir;
  }

  it('prints just the version for --version alone', () => {
    const moduleDir = makeFakeModuleDir('9.9.9', null);

    const c = capture();
    const code = run(['--version'], moduleDir);
    c.restore();

    expect(code).toBe(0);
    expect(c.out).toEqual(['9.9.9']);
  });

  it('--version --verify prints version, SCHEMA_VERSION, and the sha256 of the sibling index.js', () => {
    const indexContent = 'module.exports = { hello: "world" };\n';
    const moduleDir = makeFakeModuleDir('9.9.9', indexContent);

    const c = capture();
    const code = run(['--version', '--verify'], moduleDir);
    c.restore();

    expect(code).toBe(0);
    const [version, schemaVersion, hash] = c.out.join('\n').split('\n');
    expect(version).toBe('9.9.9');
    // This is the regression this test exists for: the CLI must report the
    // exact SCHEMA_VERSION the library exports, never a separately hardcoded one.
    expect(schemaVersion).toBe(String(SCHEMA_VERSION));
    expect(hash).toBe(createHash('sha256').update(indexContent).digest('hex'));
  });
});
