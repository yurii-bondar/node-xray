// `xray replay <file>`: a `--record` file read back through the same collector, so the summary,
// dashboard, report, profiles and budgets are what the live run would have produced.

import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import readline from 'node:readline';
import { decodeStreamMessage, HOST_CONNECTION, recordPayload, type SourceReport } from '@node-xray/core';
import type { ReplayOptions } from './args.js';
import type { OpenLink } from './collector.js';
import { Interrupts, openSession } from './session.js';

export class ReplayError extends Error {
  override name = 'ReplayError';
}

export interface ReplayResult {
  readonly exitCode: number;
  readonly sources: readonly SourceReport[];
  /** Lines that were not records, or not valid messages. */
  readonly skipped: number;
}

export async function replay(options: ReplayOptions, stderr: NodeJS.WritableStream = process.stderr): Promise<ReplayResult> {
  const interrupts = new Interrupts();
  try {
    return await replayWith({ options, stderr, interrupts });
  } finally {
    interrupts.dispose();
  }
}

interface ReplayArgs {
  readonly options: ReplayOptions;
  readonly stderr: NodeJS.WritableStream;
  readonly interrupts: Interrupts;
}

async function replayWith({ options, stderr, interrupts }: ReplayArgs): Promise<ReplayResult> {
  try {
    await access(options.file);
  } catch {
    throw new ReplayError(`cannot read ${options.file}`);
  }
  const session = await openSession({ options, status: { state: 'replay', command: `replay ${options.file}` }, stderr, probeHost: false });
  try {
    const links = new Map<number, OpenLink>();
    let skipped = 0;
    let records = 0;
    const lines = readline.createInterface({ input: createReadStream(options.file, 'utf8'), crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      // Ctrl+C during a long file: summarise what was read so far.
      if (interrupts.count > 0) break;
      if (line.trim() === '') continue;
      const payload = recordPayload(line);
      if (payload === null) {
        skipped++;
        continue;
      }
      records++;
      if ('closed' in payload) {
        // As live: the collector frees what it kept for the connection beyond the most recent ended ones.
        links.get(payload.connection)?.closed();
        links.delete(payload.connection);
        continue;
      }
      if (payload.connection === HOST_CONNECTION) {
        const parsed = decodeStreamMessage(payload.raw);
        if (parsed.ok && parsed.value.type === 'host') session.collector.applyHost(parsed.value);
        else skipped++;
        continue;
      }
      let link = links.get(payload.connection);
      if (link === undefined) {
        // A recording cannot take commands: the dashboard's buttons reach nobody.
        link = session.collector.open({ send: () => undefined, close: () => undefined });
        links.set(payload.connection, link);
      }
      link.line(payload.raw);
    }
    lines.close();
    for (const link of links.values()) link.closed();
    if (records === 0) throw new ReplayError(`${options.file} has no xray records (is it a --record file?)`);
    const stopped = interrupts.count > 0;
    stderr.write(`xray: replayed ${records} records from ${options.file}${skipped > 0 ? ` (${skipped} lines skipped)` : ''}${stopped ? ', stopped by an interrupt' : ''}\n`);

    if (session.dashboard !== null && !stopped) {
      stderr.write('xray: the dashboard stays up. Ctrl+C to finish.\n');
      await interrupts.wait();
    }
    interrupts.finishing({ stderr });
    const outcome = await session.finish();
    return { exitCode: outcome.failed ? 1 : 0, sources: outcome.sources, skipped };
  } finally {
    await session.close();
  }
}
