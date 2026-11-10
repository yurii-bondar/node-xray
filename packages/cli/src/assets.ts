// Where the agent bundles and the dashboard are. Bundled (the VS Code extension ships the CLI as
// one file) they sit next to it; in the repo they are workspace packages.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Assets {
  /** Preload bundle for `run`. */
  readonly agent: string;
  /** Bundle `attach` has the target load. */
  readonly attach: string;
  /** Built dashboard directory. */
  readonly dashboard: string;
}

let cached: Assets | null = null;

export function assets(): Assets {
  if (cached !== null) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (existsSync(path.join(here, 'agent.cjs'))) {
    cached = { agent: path.join(here, 'agent.cjs'), attach: path.join(here, 'attach.cjs'), dashboard: path.join(here, 'dashboard') };
  } else {
    const resolve = createRequire(import.meta.url).resolve;
    cached = {
      agent: resolve('@node-xray/agent'),
      attach: resolve('@node-xray/agent/attach'),
      dashboard: path.join(path.dirname(resolve('@node-xray/dashboard/package.json')), 'dist'),
    };
  }
  return cached;
}
