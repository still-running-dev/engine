/**
 * The README promises this tool makes no network requests. That claim is
 * only worth anything if CI enforces it, so this fails the build the moment
 * anything under src/ imports a networking module — regardless of whether
 * it is spelled with the `node:` prefix.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = ['http', 'https', 'net', 'dns'];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function forbiddenImports(source: string): string[] {
  const hits: string[] = [];
  for (const mod of FORBIDDEN) {
    const fromImport = new RegExp(`\\bfrom\\s+['"](?:node:)?${mod}['"]`);
    const requireCall = new RegExp(`\\brequire\\(\\s*['"](?:node:)?${mod}['"]\\s*\\)`);
    if (fromImport.test(source) || requireCall.test(source)) hits.push(mod);
  }
  return hits;
}

describe('no network access from src/', () => {
  it('never imports node:http, node:https, node:net, or node:dns', () => {
    const root = join(__dirname, '..', 'src');
    const offenders = listTsFiles(root)
      .map((file) => ({ file, hits: forbiddenImports(readFileSync(file, 'utf8')) }))
      .filter((r) => r.hits.length > 0);

    expect(offenders).toEqual([]);
  });
});
