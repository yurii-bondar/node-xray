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

  it("times only the outer call of Node's chained async calls, and the app's next calls again", async () => {
    const records: Array<[string, boolean]> = [];
    const t = timer(records);
    const later = (callback: unknown, ...results: unknown[]): void => void setImmediate(() => (callback as Fn)(...results));
    const close = wrapCallback('close', (_fd: unknown, cb: unknown) => later(cb, null), t);
    const write = wrapCallback('write', (_fd: unknown, cb: unknown) => later(cb, null), t);
    const open = wrapCallback('open', (_path: unknown, cb: unknown) => later(cb, null, 3), t);
    // Like Node's `appendFile` → `writeFile` → `open`, then `write` and `close` from the callbacks.
    const writeFile = wrapCallback('writeFile', (path: unknown, cb: unknown) => open(path, (_e: unknown, fd: unknown) => write(fd, () => close(fd, cb))), t);
    const appendFile = wrapCallback('appendFile', (path: unknown, cb: unknown) => writeFile(path, cb), t);
    const stat = wrapCallback('stat', (_path: unknown, cb: unknown) => later(cb, null), t);
    await new Promise<void>((resolve) => appendFile('/log', () => stat('/next', () => resolve())));
    assert.deepEqual(records, [['appendFile /log', false], ['stat /next', false]]);
    assert.equal(t.nesting.depth, 0);
  });

  it('marks the synchronous part of a promise call as nested', async () => {
    const records: Array<[string, boolean]> = [];
    const t = timer(records);
    const lstat = wrapCallback('lstat', (_path: unknown, cb: unknown) => void setImmediate(() => (cb as Fn)(null)), t);
    const rm = wrapPromise('rm', (path: unknown) => new Promise((resolve) => lstat(path, () => resolve(undefined))), t);
    await rm('/tmp/x');
    assert.deepEqual(records, [['rm /tmp/x', false]]);
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

describe('IoMonitor', () => {
  it('wraps again on restart what it put back, also when someone wrapped on top of another', () => {
    // In a child: this patches the real `fs`.
    const module = new URL('../src/io-monitor.js', import.meta.url).href;
    const selfModule = new URL('../src/self.js', import.meta.url).href;
    const script = `import fs from 'node:fs';
      import { IoMonitor } from ${JSON.stringify(module)};
      import { SelfWork } from ${JSON.stringify(selfModule)};
      const io = new IoMonitor({ self: new SelfWork(() => {}), send: () => {}, now: () => performance.now(), timeOrigin: 0, intervalMs: 1000 });
      io.startFs();
      const ours = fs.close;
      fs.close = function gracefulClose(...args) { return ours.apply(this, args); };
      io.stopFs();
      io.startFs();
      fs.statSync('/');
      await fs.promises.stat('/');
      await new Promise((resolve) => fs.close(fs.openSync('/dev/null', 'r'), resolve));
      const keys = [...io.fs.snapshot().operations, ...io.fsSync.snapshot().operations].map((o) => o.key);
      console.log(JSON.stringify(keys));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const keys = JSON.parse(result.stdout) as string[];
    for (const key of ['statSync /', 'stat /', 'openSync /dev/null', 'close (fd)']) assert.ok(keys.includes(key), keys.join(', '));
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
