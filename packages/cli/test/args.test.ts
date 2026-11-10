import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs, parseDuration } from '../src/args.js';
import { runExitCode, withPreload } from '../src/run.js';
import { startupCommands } from '../src/session.js';

describe('parseDuration', () => {
  it('reads ms, s, m and bare seconds', () => {
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('10s'), 10_000);
    assert.equal(parseDuration('2m'), 120_000);
    assert.equal(parseDuration('1.5'), 1500);
    assert.equal(parseDuration('0'), null);
    assert.equal(parseDuration('ten'), null);
  });
});

describe('parseArgs', () => {
  it('reads options up to the command, keeping its own flags', () => {
    assert.deepEqual(parseArgs(['run', '--cpu', '--trace-loop', '5s', '--report', 'r.json', 'node', '--inspect', 'app.js']), {
      kind: 'run',
      options: { command: 'node', args: ['--inspect', 'app.js'], intervalMs: 1000, cpu: true, heap: false, fs: false, traceLoopMs: 5000, record: null, report: 'r.json', profiles: null, ui: null, budgets: [] },
    });
  });

  it('accepts -- before the command', () => {
    const cli = parseArgs(['run', '--heap', '--interval', '250ms', '--', 'npm', 'start']);
    assert.equal(cli.kind, 'run');
    if (cli.kind !== 'run') return;
    assert.deepEqual([cli.options.command, cli.options.args, cli.options.heap, cli.options.intervalMs], ['npm', ['start'], true, 250]);
  });

  it('turns on the dashboard with faster samples unless the interval is given', () => {
    const open = parseArgs(['run', '--open', 'node', 'a.js']);
    assert.ok(open.kind === 'run');
    assert.deepEqual([open.options.ui, open.options.intervalMs], [{ port: 0, open: true }, 250]);
    const port = parseArgs(['run', '--port', '7777', '--interval', '1s', 'node']);
    assert.ok(port.kind === 'run');
    assert.deepEqual([port.options.ui, port.options.intervalMs], [{ port: 7777, open: false }, 1000]);
    assert.deepEqual(parseArgs(['run', '--port', '99999', 'node']), { kind: 'error', message: "--port: '99999' is not a port" });
  });

  it('reads attach: options, then the pid', () => {
    assert.deepEqual(parseArgs(['attach', '--cpu', '--duration', '30s', '--inspect-port', '9333', '4242']), {
      kind: 'attach',
      options: { intervalMs: 1000, cpu: true, heap: false, fs: false, traceLoopMs: null, record: null, report: null, profiles: null, ui: null, budgets: [], pid: 4242, inspectPort: 9333, durationMs: 30_000 },
    });
    assert.deepEqual(parseArgs(['attach']), { kind: 'error', message: 'missing <pid> to attach to' });
    assert.deepEqual(parseArgs(['attach', 'node']), { kind: 'error', message: "'node' is not a process id" });
    assert.deepEqual(parseArgs(['attach', '42', 'extra']), { kind: 'error', message: "unexpected 'extra' after the pid" });
    assert.deepEqual(parseArgs(['run', '--duration', '5s', 'node']), { kind: 'error', message: '--duration is for attach' });
    assert.deepEqual(parseArgs(['run', '--inspect-port', '1', 'node']), { kind: 'error', message: '--inspect-port is for attach' });
  });

  it('reads budgets, repeated or comma-separated, and rejects bad ones', () => {
    const cli = parseArgs(['run', '--budget', 'loop.p99<50ms,gc.pause<5%', '--budget', 'rss.max<1GiB', 'node']);
    assert.ok(cli.kind === 'run');
    assert.deepEqual(cli.options.budgets.map((b) => b.metric), ['loop.p99', 'gc.pause', 'rss.max']);
    assert.deepEqual(parseArgs(['run', '--budget', 'loop.p99<50MiB', 'node']), { kind: 'error', message: "--budget 'loop.p99<50MiB': loop.p99 takes a duration (50ms, 1.5s)" });
  });

  it('reads replay: output options only, then the file', () => {
    const cli = parseArgs(['replay', '--open', '--budget', 'loop.p99<50ms', '--profiles', 'out', 'run.xray.jsonl']);
    assert.ok(cli.kind === 'replay');
    assert.deepEqual([cli.options.file, cli.options.ui, cli.options.profiles, cli.options.budgets.length], ['run.xray.jsonl', { port: 0, open: true }, 'out', 1]);
    assert.deepEqual(parseArgs(['replay', '--cpu', 'x.jsonl']), { kind: 'error', message: '--cpu collects data; a replay only reads a recording' });
    assert.deepEqual(parseArgs(['replay']), { kind: 'error', message: 'missing <file> to replay' });
  });

  it('explains what is wrong', () => {
    assert.deepEqual(parseArgs(['run']), { kind: 'error', message: 'missing <command> to run' });
    assert.deepEqual(parseArgs(['run', '--interval', '10ms', 'node']), { kind: 'error', message: '--interval must be at least 50ms' });
    assert.deepEqual(parseArgs(['run', '--trace-loop']), { kind: 'error', message: '--trace-loop needs a value' });
    assert.deepEqual(parseArgs(['run', '--trace-loop', 'soon', 'node']), { kind: 'error', message: "--trace-loop: 'soon' is not a duration" });
    assert.deepEqual(parseArgs(['run', '--fast', 'node']), { kind: 'error', message: "unknown option '--fast'" });
    assert.deepEqual(parseArgs(['profile']), { kind: 'error', message: "unknown command 'profile'" });
    assert.deepEqual(parseArgs([]), { kind: 'help' });
    assert.deepEqual(parseArgs(['--version']), { kind: 'version' });
  });
});

describe('run helpers', () => {
  it('quotes the agent path into NODE_OPTIONS after what the user had', () => {
    assert.equal(withPreload(undefined, '/My Apps/agent.cjs'), '--require "/My Apps/agent.cjs"');
    assert.equal(withPreload(' --max-old-space-size=512 ', '/a.cjs'), '--max-old-space-size=512 --require "/a.cjs"');
    assert.equal(withPreload('', 'C:\\x\\a.cjs'), '--require "C:\\\\x\\\\a.cjs"');
  });

  it('decides the exit code: the command first, then budgets; a stop by signal is clean', () => {
    assert.equal(runExitCode({ code: 3, signal: null, budgetsFailed: false }), 3);
    assert.equal(runExitCode({ code: 3, signal: null, budgetsFailed: true }), 3);
    assert.equal(runExitCode({ code: 0, signal: null, budgetsFailed: true }), 1);
    assert.equal(runExitCode({ code: 143, signal: 'SIGTERM', budgetsFailed: false }), 0);
    assert.equal(runExitCode({ code: 130, signal: 'SIGINT', budgetsFailed: true }), 1);
    assert.equal(runExitCode({ code: 137, signal: 'SIGKILL', budgetsFailed: false }), 137);
  });

  it('turns flags into startup commands', () => {
    const cli = parseArgs(['run', '--cpu', '--heap', '--fs', '--trace-loop', '3s', 'node']);
    assert.equal(cli.kind, 'run');
    if (cli.kind !== 'run') return;
    assert.deepEqual(
      startupCommands(cli.options).map((c) => c.type),
      ['cpu-profile-start', 'heap-sampling-start', 'fs-timing-start', 'loop-trace-start'],
    );
  });
});
