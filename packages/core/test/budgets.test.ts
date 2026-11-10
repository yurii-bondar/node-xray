import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { budgetsFailed, checkBudgets, formatMetric, parseBudget, parseBudgets, type Budget } from '../src/budgets.js';
import { encodeRecord, recordPayload } from '../src/record.js';
import { buildReport, type SourceReport } from '../src/report.js';
import { Timeline } from '../src/timeline.js';
import { hello, MiB, sample } from './fixtures.js';

function budget(text: string): Budget {
  const parsed = parseBudget(text);
  if (typeof parsed === 'string') assert.fail(parsed);
  return parsed;
}

describe('parseBudget', () => {
  it('reads metrics, comparisons and units into each metric’s unit', () => {
    assert.deepEqual(budget('loop.p99<50ms'), { text: 'loop.p99<50ms', metric: 'loop.p99', comparison: '<', limit: 50 });
    assert.equal(budget('loop.max <= 1.5s').limit, 1500);
    assert.equal(budget('rss.max<512MiB').limit, 512 * MiB);
    assert.equal(budget('heap.growth<5MiB/min').limit, 5 * MiB);
    assert.equal(budget('http.errors<1%').limit, 1);
    assert.equal(budget('http.rps>=100/s').comparison, '>=');
    assert.equal(budget('cpu.avg<80').limit, 80);
  });

  it('explains what is wrong', () => {
    assert.match(String(parseBudget('loop.p99 under 50')), /expected <metric><op><limit>/);
    assert.match(String(parseBudget('loop.p90<50ms')), /unknown metric 'loop.p90' \(known: cpu\.avg/);
    assert.equal(parseBudget('loop.p99<50MiB'), "'loop.p99<50MiB': loop.p99 takes a duration (50ms, 1.5s)");
    assert.equal(parseBudget('heap.growth<5MiB'), "'heap.growth<5MiB': heap.growth takes a rate per minute (5MiB/min)");
  });

  it('splits comma-separated lists and stops at the first bad one', () => {
    const list = parseBudgets(['loop.p99<50ms, gc.pause<5%', 'rss.max<1GiB']);
    assert.ok(Array.isArray(list));
    assert.deepEqual(list.map((b) => b.metric), ['loop.p99', 'gc.pause', 'rss.max']);
    assert.match(String(parseBudgets(['loop.p99<50ms,nope<1'])), /unknown metric 'nope'/);
  });
});

describe('checkBudgets', () => {
  function report(): SourceReport {
    const timeline = new Timeline();
    timeline.apply(hello);
    timeline.apply(sample(1000));
    timeline.apply(sample(2000, { loopDelay: { min: 0, max: 90, mean: 2, stddev: 5, p50: 1, p90: 2, p99: 70 } }));
    const built = buildReport(timeline);
    assert.ok(built);
    return built;
  }

  it('passes, fails, or skips when the run has no data for the metric', () => {
    const results = checkBudgets([budget('loop.p99<50ms'), budget('loop.max<100ms'), budget('http.p99<300ms'), budget('heap.growth<1MiB/min')], [report()]);
    assert.deepEqual(
      results.map((r) => [r.budget.metric, r.outcome, r.actual]),
      [
        ['loop.p99', 'fail', 70],
        ['loop.max', 'pass', 90],
        ['http.p99', 'skipped', null],
        ['heap.growth', 'skipped', null],
      ],
    );
    assert.equal(budgetsFailed(results), true);
    assert.equal(budgetsFailed(results.filter((r) => r.outcome !== 'fail')), false);
  });

  it('formats values in the metric’s unit', () => {
    assert.equal(formatMetric('loop.p99', 70), '70 ms');
    assert.equal(formatMetric('rss.max', 512 * MiB), '512.0 MiB');
    assert.equal(formatMetric('heap.growth', -2 * MiB), '−2.0 MiB/min');
    assert.equal(formatMetric('http.errors', 1.25), '1.3 %');
  });
});

describe('recordPayload', () => {
  it('gives back the message text exactly as recorded', () => {
    const raw = '{"type":"sample","gc":[{"start":1,"duration":2,"kind":4}]}';
    assert.deepEqual(recordPayload(`${encodeRecord(7, raw)}\n`), { connection: 7, raw });
    assert.equal(recordPayload('{"m":{}}'), null);
  });
});
