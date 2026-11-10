import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkBudgets, parseBudgets, type Budget } from '../src/budgets.js';
import { bucketOf, HTTP_BUCKET_COUNT } from '../src/http.js';
import { analyzeIo } from '../src/insights.js';
import { emptyIoSide, ioRates, summarizeIo, type IoMessage, type IoSide } from '../src/io.js';
import { parseStreamMessage } from '../src/protocol.js';
import { buildReport } from '../src/report.js';
import { describeInsight } from '../src/text.js';
import { Timeline } from '../src/timeline.js';
import { hello, sample } from './fixtures.js';

function side(calls: ReadonlyArray<[string, number]>, failed = 0): IoSide {
  const histogram = new Array<number>(HTTP_BUCKET_COUNT).fill(0);
  const ops = new Map<string, { key: string; count: number; errors: number; totalMs: number; maxMs: number }>();
  let total = 0;
  let max = 0;
  for (const [key, ms] of calls) {
    histogram[bucketOf(ms)] = (histogram[bucketOf(ms)] ?? 0) + 1;
    const op = ops.get(key) ?? { key, count: 0, errors: 0, totalMs: 0, maxMs: 0 };
    op.count++;
    op.totalMs += ms;
    op.maxMs = Math.max(op.maxMs, ms);
    ops.set(key, op);
    total += ms;
    max = Math.max(max, ms);
  }
  const slowest = [...calls].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, ms]) => ({ key, ms, failed: false }));
  return { calls: calls.length, errors: failed, totalMs: total, maxMs: max, histogram, operations: [...ops.values()], slowest };
}

function tick(t: number, parts: Partial<Pick<IoMessage, 'fs' | 'fsSync' | 'dns'>>): IoMessage {
  return { type: 'io', start: t - 1000, end: t, fs: emptyIoSide(), fsSync: emptyIoSide(), dns: emptyIoSide(), ...parts };
}

describe('io ticks', () => {
  it('parse and turn into rates', () => {
    const message = tick(2000, { fs: side([['stat /etc/hosts', 0.2], ['readFile /srv/a.json', 3]]) });
    assert.deepEqual(parseStreamMessage(JSON.parse(JSON.stringify(message))), { ok: true, value: message });
    const rates = ioRates(message.fs, message);
    assert.equal(rates.perSec, 2);
    assert.equal(rates.max, 3);
    assert.ok(Math.abs(rates.msPerSec - 3.2) < 1e-9);
  });

  it('add up per kind, heaviest operations first', () => {
    const summary = summarizeIo(
      [tick(1000, { dns: side([['lookup a.example', 12], ['lookup b.example', 3]]) }), tick(2000, { dns: side([['lookup a.example', 40]], 1) })],
      'dns',
    );
    assert.ok(summary);
    assert.deepEqual([summary.calls, summary.errors, summary.perSec, summary.max], [3, 1, 1.5, 40]);
    assert.deepEqual(summary.operations.map((o) => [o.key, o.count, o.totalMs]), [
      ['lookup a.example', 2, 52],
      ['lookup b.example', 1, 3],
    ]);
    assert.equal(summary.slowest[0]?.key, 'lookup a.example');
    assert.equal(summarizeIo([tick(1000, {})], 'fs'), null);
  });
});

describe('io findings and budgets', () => {
  const windows = [
    tick(1000, { fsSync: side([['readFileSync /srv/big.json', 35]]), dns: side([['lookup slow.example', 450]]) }),
    tick(2000, { fsSync: side([['statSync /x', 1]]), dns: side([['lookup fast.example', 2]]) }),
  ];

  it('reports blocking sync fs and slow DNS', () => {
    const insights = analyzeIo(windows);
    assert.deepEqual(insights.map((i) => i.kind), ['fs-blocking', 'dns-slow']);
    assert.equal(describeInsight(insights[0] as (typeof insights)[number], 0), 'synchronous file system calls blocked the event loop for 35 ms at +1.00 s, slowest: readFileSync /srv/big.json');
    assert.equal(describeInsight(insights[1] as (typeof insights)[number], 0), 'DNS lookup slow.example took 450 ms at +1.00 s');
  });

  it('feeds the report and the fs / dns budgets', () => {
    const timeline = new Timeline();
    timeline.apply(hello);
    timeline.apply(sample(1000));
    timeline.apply(sample(2000));
    for (const w of windows) timeline.apply(w);
    const report = buildReport(timeline);
    assert.ok(report);
    assert.equal(report.io.fsSync?.totalMs, 36);
    assert.equal(report.io.fs, null);
    assert.ok(report.insights.some((i) => i.kind === 'fs-blocking'));
    const budgets = parseBudgets(['fs.sync<10ms,dns.max<1s,fs.p99<50ms']) as Budget[];
    assert.deepEqual(
      checkBudgets(budgets, [report]).map((r) => [r.budget.metric, r.outcome]),
      [
        ['fs.sync', 'fail'],
        ['dns.max', 'pass'],
        ['fs.p99', 'skipped'],
      ],
    );
  });
});
