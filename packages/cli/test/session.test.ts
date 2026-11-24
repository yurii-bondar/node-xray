import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { childEnv } from '../src/run.js';
import { FORCED_QUIT_CODE, Interrupts, Recording } from '../src/session.js';

describe('Interrupts', () => {
  it('keeps the default action away until disposed, and waits for the next interrupt', async () => {
    const signals = new EventEmitter();
    const interrupts = new Interrupts(signals);
    assert.equal(signals.listenerCount('SIGINT'), 1);
    assert.equal(signals.listenerCount('SIGTERM'), 1);

    signals.emit('SIGINT'); // nobody waits: ignored, but counted
    assert.equal(interrupts.count, 1);
    let woken = false;
    const next = interrupts.wait().then(() => (woken = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(woken, false, 'an earlier interrupt does not count for wait()');
    signals.emit('SIGTERM');
    await next;
    await interrupts.wait(0); // any interrupt since the start

    interrupts.dispose();
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  });

  it('during the summary, warns on the first interrupt and quits after cleanup on the second', () => {
    const signals = new EventEmitter();
    const exits: number[] = [];
    const log: string[] = [];
    const interrupts = new Interrupts(signals, (code) => {
      log.push(`exit ${code}`);
      exits.push(code);
    });
    signals.emit('SIGINT'); // before the summary: stops the program / ends the dashboard wait
    signals.emit('SIGINT');
    assert.deepEqual(exits, [], 'interrupts before finishing never quit');

    let stderr = '';
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        stderr += chunk.toString();
        done();
      },
    });
    interrupts.finishing({ stderr: sink, cleanup: () => log.push('cleanup') });
    signals.emit('SIGINT');
    assert.equal(stderr, 'xray: finishing the summary; Ctrl+C again to quit without it\n');
    assert.deepEqual(exits, [], 'the first one only warns');
    signals.emit('SIGTERM');
    assert.deepEqual(log, ['cleanup', `exit ${FORCED_QUIT_CODE}`]);
    assert.equal(FORCED_QUIT_CODE, 130);
    interrupts.dispose();
  });

  it('quits even when the cleanup throws', () => {
    const signals = new EventEmitter();
    const exits: number[] = [];
    const interrupts = new Interrupts(signals, (code) => exits.push(code));
    const quiet = new Writable({ write: (_chunk, _encoding, done) => done() });
    interrupts.finishing({
      stderr: quiet,
      cleanup: () => {
        throw new Error('EBUSY');
      },
    });
    signals.emit('SIGINT');
    signals.emit('SIGINT');
    assert.deepEqual(exits, [130]);
    interrupts.dispose();
  });
});

describe('Recording', () => {
  it('stops at the first write error, says so once, and keeps the run going', async () => {
    const written: string[] = [];
    let writes = 0;
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        writes++;
        done(writes === 2 ? Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) : null);
        if (writes !== 2) written.push(chunk.toString());
      },
    });
    let stderr = '';
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        stderr += chunk.toString();
        done();
      },
    });
    const recording = new Recording({ stream, file: 'run.xray.jsonl', stderr: sink });
    recording.write('a\n');
    recording.write('b\n');
    await new Promise((resolve) => setImmediate(resolve));
    recording.write('c\n');
    recording.write('d\n');
    await recording.close();
    assert.deepEqual(written, ['a\n']);
    assert.equal(stderr, 'xray: recording to run.xray.jsonl stopped: ENOSPC: no space left on device\n');
  });
});

describe('childEnv', () => {
  it('keeps the dashboard token and host from the profiled program, and adds what the agent needs', () => {
    const env = childEnv(
      { PATH: '/bin', XRAY_DASHBOARD_TOKEN: 'secret-token-0123456789', xray_dashboard_host: 'x.dev', NODE_OPTIONS: '--max-old-space-size=100' },
      { agent: '/opt/x ray/agent.cjs', socketPath: '/tmp/s.sock', intervalMs: 250 },
    );
    assert.deepEqual(env, {
      PATH: '/bin',
      NODE_OPTIONS: '--max-old-space-size=100 --require "/opt/x ray/agent.cjs"',
      XRAY_SOCKET: '/tmp/s.sock',
      XRAY_INTERVAL_MS: '250',
    });
  });
});
