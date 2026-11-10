// `xray replay <file>`: a `--record` file read back through the same collector, so the summary,
// dashboard, report, profiles and budgets are what the live run would have produced.

import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import readline from 'node:readline';
import { HOST_CONNECTION, parseStreamMessage, recordPayload, type SourceReport } from '@node-xray/core';
import type { ReplayOptions } from './args.js';
import type { OpenLink } from './collector.js';
import { openSession, waitForInterrupt } from './session.js';

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
      if (line.trim() === '') continue;
      const payload = recordPayload(line);
      if (payload === null) {
        skipped++;
        continue;
      }
      records++;
      if (payload.connection === HOST_CONNECTION) {
        const parsed = parseStreamMessage(JSON.parse(payload.raw) as unknown);
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
    for (const link of links.values()) link.closed();
    if (records === 0) throw new ReplayError(`${options.file} has no xray records (is it a --record file?)`);
    stderr.write(`xray: replayed ${records} records from ${options.file}${skipped > 0 ? ` (${skipped} lines skipped)` : ''}\n`);

    if (session.dashboard !== null) {
      stderr.write('xray: the dashboard stays up. Ctrl+C to finish.\n');
      await waitForInterrupt();
    }
    const outcome = await session.finish();
    return { exitCode: outcome.failed ? 1 : 0, sources: outcome.sources, skipped };
  } finally {
    await session.close();
  }
}
