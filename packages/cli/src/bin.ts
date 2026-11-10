#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs, USAGE } from './args.js';
import { attach, AttachError } from './attach.js';
import { CdpError } from './cdp.js';
import { replay, ReplayError } from './replay.js';
import { run } from './run.js';

function version(): string {
  let manifest: unknown;
  try {
    manifest = createRequire(import.meta.url)('../../package.json');
  } catch {
    // Bundled into the VS Code extension: no package.json next to it.
    return 'bundled';
  }
  const value: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : undefined;
  return typeof value === 'string' ? value : 'unknown';
}

const cli = parseArgs(process.argv.slice(2));
switch (cli.kind) {
  case 'help':
    process.stdout.write(`${USAGE}\n`);
    break;
  case 'version':
    process.stdout.write(`${version()}\n`);
    break;
  case 'error':
    process.stderr.write(`xray: ${cli.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    break;
  case 'run':
    process.exitCode = (await run(cli.options)).exitCode;
    break;
  case 'attach':
    try {
      process.exitCode = (await attach(cli.options)).exitCode;
    } catch (error) {
      if (!(error instanceof AttachError) && !(error instanceof CdpError)) throw error;
      process.stderr.write(`xray: ${error.message}\n`);
      process.exitCode = 1;
    }
    break;
  case 'replay':
    try {
      process.exitCode = (await replay(cli.options)).exitCode;
    } catch (error) {
      if (!(error instanceof ReplayError)) throw error;
      process.stderr.write(`xray: ${error.message}\n`);
      process.exitCode = 1;
    }
    break;
  default: {
    const unreachable: never = cli;
    throw new Error(`unhandled ${JSON.stringify(unreachable)}`);
  }
}
