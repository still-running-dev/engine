/**
 * Turns a file or directory path into one `analyze()` outcome per file. A
 * directory run must survive a malformed file in it — see `analyzeFile`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../index.js';
import type { AnalysisResult } from '../core/model.js';

export interface FileAnalysis {
  file: string;
  ok: true;
  result: AnalysisResult;
}

export interface FileFailure {
  file: string;
  ok: false;
  error: string;
}

export type FileOutcome = FileAnalysis | FileFailure;

/** Every `.json` file under `root`, recursive — or `[root]` if it is a file. */
export function findJsonFiles(root: string): string[] {
  const stat = statSync(root);
  if (stat.isFile()) return [root];

  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Never throws — a file that fails to read or parse becomes a FileFailure. */
export function analyzeFile(file: string): FileOutcome {
  try {
    const raw = readFileSync(file, 'utf8');
    return { file, ok: true, result: analyze(raw) };
  } catch (err) {
    return { file, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function analyzePath(root: string): FileOutcome[] {
  return findJsonFiles(root).map(analyzeFile);
}
