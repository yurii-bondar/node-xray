import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { IoAggregator, operationKey, wrapCallback, wrapPromise, wrapSync } from '../src/io-monitor.js';
import { SelfWork } from '../src/self.js';

type Fn = (this: unknown, ...args: unknown[]) => unknown;

function timer(records: Array<[string, boolean]>, self = new SelfWork(() => undefined), on = true) {
  return { self, enabled: () => on, record: (key: string, _ms: number, failed: boolean) => records.push([key, failed]), nesting: { depth: 0 } };
}

describe('fs wrappers', () => {
  it('callback: same arguments and this, timed with the error state', async () => {
    const records: Array<[string, boolean]> = [];
    const original: Fn = function (this: unknown, path: unknown, cb: unknown) {
      setImmediate(() => (cb as Fn).call(this, path === '/missing' ? new Error('ENOENT') : null, `data of ${String(path)}`));
    };
    const wrapped = wrapCallback('readFile', original, timer(records));
    const got = await new Promise<unknown[]>((resolve) => wrapped('/etc/hosts', (...args: unknown[]) => resolve(args)));
    assert.deepEqual(got, [null, 'data of /etc/hosts']);
    await new Promise<void>((resolve) => wrapped('/missing', () => resolve()));
    assert.deepEqual(records, [['readFile /etc/hosts', false], ['readFile /missing', true]]);
  });

  it('promise: same value, rejection passed on', async () => {
    const records: Array<[string, boolean]> = [];
    const ok = wrapPromise('stat', async () => 'stats', timer(records));
    assert.equal(await ok('/a'), 'stats');
    const failing = wrapPromise('stat', () => Promise.reject(new Error('nope')), timer(records));
    await assert.rejects(failing('/b') as Promise<unknown>, /nope/);
    assert.deepEqual(records, [['stat /a', false], ['stat /b', true]]);
  });

  it('promise: a rejection the app leaves unhandled still crashes it as before', () => {
    // In a child: the test runner here would catch the unhandled rejection itself.
    const module = new URL('../src/io-monitor.js', import.meta.url).href;
    const script = `import { wrapPromise } from ${JSON.stringify(module)};
      import { SelfWork } from ${JSON.stringify(new URL('../src/self.js', import.meta.url).href)};
      const wrapped = wrapPromise('stat', () => Promise.reject(new Error('left unhandled')), { self: new SelfWork(() => {}), enabled: () => true, record: () => {}, nesting: { depth: 0 } });
      wrapped('/x');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /left unhandled/);
  });

  it('sync: returns or throws as before, timed either way', () => {
    const records: Array<[string, boolean]> = [];
    const wrapped = wrapSync('readFile', (path: unknown) => {
      if (path === '/missing') throw new Error('ENOENT');
      return 'x';
    }, timer(records));
    assert.equal(wrapped('/a'), 'x');
    assert.throws(() => wrapped('/missing'), /ENOENT/);
    assert.deepEqual(records, [['readFileSync /a', false], ['readFileSync /missing', true]]);
  });

  it('times only the outermost of nested sync calls', () => {
    const records: Array<[string, boolean]> = [];
    const t = timer(records);
    const readSync = wrapSync('read', () => 1, t);
    const readFileSync = wrapSync('readFile', (path: unknown) => [readSync(3), readSync(3), path], t);
    readFileSync('/big.json');
    readSync(4);
    assert.deepEqual(records, [['readFileSync /big.json', false], ['readSync (fd)', false]]);
  });

  it('keeps own properties such as util.promisify.custom', async () => {
    const original = Object.assign(function legacy(cb: Fn) { cb(null, 1); }, { [promisify.custom]: async () => 'custom' });
    const wrapped = wrapCallback('read', original as unknown as Fn, timer([]));
    assert.equal(await promisify(wrapped as unknown as () => void)(), 'custom');
    assert.equal(wrapped.name, 'legacy');
  });

  it('does not time the agent’s own calls, nor anything while off', () => {
    const records: Array<[string, boolean]> = [];
    const self = new SelfWork(() => undefined);
    const wrapped = wrapSync('stat', () => 1, timer(records, self));
    self.run(() => void wrapped('/proc/self/status'));
    wrapSync('stat', () => 1, timer(records, self, false))('/x');
    assert.deepEqual(records, []);
  });

  it('keys by path, URL or fd', () => {
    assert.equal(operationKey('read', 7), 'read (fd)');
    assert.equal(operationKey('stat', new URL('file:///srv/a b.txt')), 'stat /srv/a%20b.txt');
    assert.equal(operationKey('readFile', Buffer.from('/x')), 'readFile /x');
  });
});

describe('IoAggregator', () => {
  it('bounds operations and keeps the slowest examples', () => {
    const agg = new IoAggregator();
    for (let i = 0; i < 120; i++) agg.record(`stat /f${i}`, i, i % 50 === 0);
    const side = agg.snapshot();
    assert.equal(side.calls, 120);
    assert.equal(side.errors, 3);
    assert.equal(side.operations.length, 101);
    assert.equal(side.operations.find((o) => o.key === '(other)')?.count, 20);
    assert.deepEqual(side.slowest.map((e) => e.ms), [119, 118, 117, 116, 115]);
    assert.equal(agg.snapshot().calls, 0);
  });
});
