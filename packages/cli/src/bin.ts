#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs, USAGE } from './args.js';
import { attach, AttachError } from './attach.js';
import { CdpError } from './cdp.js';
import { replay, ReplayError } from './replay.js';
import { run } from './run.js';
import { SessionError } from './session.js';

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

/** Failures the user can act on: one line, exit code 1, no stack trace. */
function expected(error: unknown): error is Error {
  return error instanceof AttachError || error instanceof CdpError || error instanceof ReplayError || error instanceof SessionError;
}

const cli = parseArgs(process.argv.slice(2));
try {
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
      process.exitCode = (await attach(cli.options)).exitCode;
      break;
    case 'replay':
      process.exitCode = (await replay(cli.options)).exitCode;
      break;
    default: {
      const unreachable: never = cli;
      throw new Error(`unhandled ${JSON.stringify(unreachable)}`);
    }
  }
} catch (error) {
  if (!expected(error)) throw error;
  process.stderr.write(`xray: ${error.message}\n`);
  process.exitCode = 1;
}
