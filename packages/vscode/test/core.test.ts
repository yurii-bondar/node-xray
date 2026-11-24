import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitCommand } from '../src/core/command.js';
import { hotMarks, markText, mergeLinesAnswers, parseLinesAnswer, tierOf } from '../src/core/hot-lines.js';
import { isAbsolutePath, mayOpen, pathKey } from '../src/core/paths.js';
import { looksLikeNode, parseNodeProcesses } from '../src/core/processes.js';
import { readSettings } from '../src/core/settings.js';
import { nodeMajor, parseRunStatus, programDone } from '../src/core/status.js';
import { dashboardHtml, dashboardUrl, forwardedHost, localFile, parseOpenRequest } from '../src/core/webview.js';

describe('splitCommand', () => {
  it('splits like a POSIX shell without running one', () => {
    assert.deepEqual(splitCommand('npm run dev -- --port 3000'), { program: 'npm', args: ['run', 'dev', '--', '--port', '3000'] });
    assert.deepEqual(splitCommand(`node "my app/server.js" --name 'a b' x\\ y`), { program: 'node', args: ['my app/server.js', '--name', 'a b', 'x y'] });
    assert.deepEqual(splitCommand('node -e "console.log(\\"hi\\")"'), { program: 'node', args: ['-e', 'console.log("hi")'] });
    assert.deepEqual(splitCommand(`node ''`), { program: 'node', args: [''] });
    assert.equal(splitCommand('node "open'), null);
    assert.equal(splitCommand('   '), null);
  });
});

describe('processes', () => {
  it('keeps Node binaries from ps output, minus excluded pids', () => {
    const ps = ['  101 /usr/local/bin/node /srv/app/server.js --port 3000', '  102 /usr/sbin/postgres -D /data', '  103 node22 worker.js', '  104 /usr/bin/nodemon app.js', '  105 node self.js', 'garbage'].join('\n');
    assert.deepEqual(parseNodeProcesses(ps, new Set([105])), [
      { pid: 101, args: '/usr/local/bin/node /srv/app/server.js --port 3000' },
      { pid: 103, args: 'node22 worker.js' },
    ]);
    assert.equal(looksLikeNode('C:\\\\nodejs\\\\node.exe'), true);
  });
});

describe('webview', () => {
  it('accepts only well-formed open requests', () => {
    assert.deepEqual(parseOpenRequest({ type: 'xray.open', url: 'file:///a/b.ts', line: 3.7, column: 0 }), { url: 'file:///a/b.ts', line: 3, column: 1 });
    assert.equal(parseOpenRequest({ type: 'xray.run', url: '/x', line: 1, column: 1 }), null);
    assert.equal(parseOpenRequest({ type: 'xray.open', url: 7, line: 1, column: 1 }), null);
    assert.equal(parseOpenRequest('nope'), null);
    assert.equal(parseOpenRequest({ type: 'xray.open', url: '/x', line: Number.NaN, column: 1 }), null);
    assert.equal(parseOpenRequest({ type: 'xray.open', url: '/x', line: 1, column: Infinity }), null);
  });

  it('opens local files only', () => {
    assert.equal(localFile('file:///srv/My%20App/x.ts'), '/srv/My App/x.ts');
    assert.equal(localFile('file:///C:/app/x.ts'), 'C:/app/x.ts');
    assert.equal(localFile('/srv/app/x.ts'), '/srv/app/x.ts');
    assert.equal(localFile('node:internal/timers'), null);
    assert.equal(localFile('webpack://app/src/x.ts'), null);
  });

  it('builds the dashboard URL with token, host and theme', () => {
    assert.equal(dashboardUrl({ base: 'http://127.0.0.1:4000', token: 'abc_-1', theme: 'light' }), 'http://127.0.0.1:4000/?token=abc_-1&host=vscode&theme=light');
  });

  it('frames the dashboard under a strict CSP, adds its own origin, relays only the dashboard', () => {
    const html = dashboardHtml({ src: 'http://127.0.0.1:4000/?token=t&host=vscode&theme=dark', origin: 'http://127.0.0.1:4000', nonce: 'n0nce' });
    assert.match(html, /default-src 'none'; frame-src http:\/\/127\.0\.0\.1:4000; script-src 'nonce-n0nce'/);
    assert.match(html, /<iframe id="dashboard" title="xray dashboard"><\/iframe>/);
    assert.match(html, /const src = new URL\("http:\/\/127\.0\.0\.1:4000\/\?token=t&host=vscode&theme=dark"\);/);
    assert.match(html, /src\.searchParams\.set\('parent', location\.origin\);/);
    assert.match(html, /const origin = "http:\/\/127\.0\.0\.1:4000";/);
    assert.match(html, /event\.source === frame\.contentWindow/);
    assert.match(html, /event\.origin === origin && data\.type === 'xray\.open'/);
    assert.match(html, /frame\.contentWindow\.postMessage\(\{ type: 'xray\.theme', theme: data\.theme \}, origin\)/);
    assert.equal(html.match(/<script/g)?.length, 1);
  });

  it('keeps values from closing the script', () => {
    const html = dashboardHtml({ src: 'http://127.0.0.1:4000/?x=</script><script>alert(1)</script>', origin: 'http://127.0.0.1:4000', nonce: 'n' });
    assert.equal(html.match(/<\/script>/g)?.length, 1);
    assert.match(html, /\\u003c\/script>/);
  });
});

describe('paths', () => {
  it('compares paths the way the platform does', () => {
    assert.equal(pathKey('C:\\App\\src\\x.ts', 'win32'), 'c:/app/src/x.ts');
    assert.equal(pathKey('c:/app/./lib/../src/x.ts', 'win32'), 'c:/app/src/x.ts');
    assert.equal(pathKey('/srv/App//src/x.ts', 'linux'), '/srv/App/src/x.ts');
    assert.notEqual(pathKey('/srv/App/x.ts', 'linux'), pathKey('/srv/app/x.ts', 'linux'));
    assert.equal(isAbsolutePath('src/x.ts'), false);
    assert.equal(isAbsolutePath('D:\\x.ts'), true);
  });

  it('opens files xray profiled or inside the workspace and the run directory only', () => {
    const rule = { seen: new Set([pathKey('C:/libs/shared/x.js', 'win32')]), roots: ['c:\\work\\app'], platform: 'win32' };
    assert.equal(mayOpen('c:\\libs\\shared\\x.js', rule), true);
    assert.equal(mayOpen('C:/Work/App/src/a.ts', rule), true);
    assert.equal(mayOpen('C:/Work/App/../secrets.txt', rule), false);
    assert.equal(mayOpen('C:/Work/Apple/a.ts', rule), false);
    assert.equal(mayOpen('relative/a.ts', rule), false);
    assert.equal(mayOpen('/etc/passwd', { seen: new Set(), roots: ['/srv/app'], platform: 'linux' }), false);
    assert.equal(mayOpen('/anything', { seen: new Set(), roots: ['/'], platform: 'linux' }), true);
  });
});

describe('settings', () => {
  const read = (values: Record<string, unknown>): ReturnType<typeof readSettings> => readSettings((key) => values[key]);

  it('falls back to defaults for missing or malformed values', () => {
    assert.deepEqual(read({}), { nodePath: 'node', cpu: true, heap: false, fs: false, hotLineShare: 0.005 });
    assert.equal(read({ nodePath: '   ' }).nodePath, 'node');
    assert.equal(read({ nodePath: 7 }).nodePath, 'node');
    assert.equal(read({ nodePath: ' /opt/node22/bin/node ' }).nodePath, '/opt/node22/bin/node');
    assert.equal(read({ cpu: 'no' }).cpu, true);
    assert.equal(read({ heap: true }).heap, true);
    assert.equal(read({ hotLineThreshold: 2 }).hotLineShare, 0.02);
    assert.equal(read({ hotLineThreshold: -1 }).hotLineShare, 0.005);
    assert.equal(read({ hotLineThreshold: 1000 }).hotLineShare, 0.005);
    assert.equal(read({ hotLineThreshold: '3' }).hotLineShare, 0.005);
    assert.equal(read({ hotLineThreshold: Number.NaN }).hotLineShare, 0.005);
  });
});

describe('status', () => {
  it('reads the CLI status and tells when the program is done', () => {
    assert.deepEqual(parseRunStatus({ state: 'exited', command: 'node a.js', code: 1 }), { state: 'exited', command: 'node a.js', code: 1 });
    assert.deepEqual(parseRunStatus({ state: 'running', command: 'node a.js', code: 'x' }), { state: 'running', command: 'node a.js' });
    assert.equal(parseRunStatus({ state: 'paused', command: 'x' }), null);
    assert.equal(parseRunStatus({ state: 'running' }), null);
    assert.equal(parseRunStatus(null), null);
    assert.equal(programDone({ state: 'running', command: '' }), false);
    assert.equal(programDone({ state: 'exited', command: '' }), true);
    assert.equal(programDone({ state: 'detached', command: '' }), true);
  });

  it('reads the major version of node --version', () => {
    assert.equal(nodeMajor('v22.11.0\n'), 22);
    assert.equal(nodeMajor('v20.0.0'), 20);
    assert.equal(nodeMajor('Python 3.12.1'), null);
    assert.equal(nodeMajor(''), null);
  });
});

describe('hot lines', () => {
  const answer = parseLinesAnswer(
    {
      work: 1000,
      files: [
        { file: '/srv/app/src/report.ts', lines: [[3, 400], [7, 30], [9, 2], ['x', 1], [0, 5], [2.5, 5], [4, -1], [5, Number.NaN], [6]] },
        { file: 7, lines: [] },
        { file: '', lines: [[1, 1]] },
      ],
    },
    'linux',
  );

  it('reads the CLI answer and marks lines above the threshold, heaviest first', () => {
    assert.ok(answer);
    assert.equal(answer.files.size, 1);
    assert.deepEqual([...(answer.files.get('/srv/app/src/report.ts') ?? [])], [
      [3, 400],
      [7, 30],
      [9, 2],
    ]);
    const marks = hotMarks({ answer, fileKey: '/srv/app/src/report.ts', minShare: 0.005 });
    assert.deepEqual(marks.map((m) => [m.line, m.tier]), [
      [3, 'hot'],
      [7, 'warm'],
    ]);
    assert.equal(markText(marks[0] ?? { line: 0, share: 0, tier: 'mild' }), '40.0 % CPU');
    assert.deepEqual(hotMarks({ answer, fileKey: '/elsewhere.ts', minShare: 0 }), []);
    assert.equal(tierOf(0.003), 'mild');
  });

  it('rejects answers without a usable work count', () => {
    assert.equal(parseLinesAnswer({ work: 'x', files: [] }, 'linux'), null);
    assert.equal(parseLinesAnswer({ work: -1, files: [] }, 'linux'), null);
    assert.equal(parseLinesAnswer({ work: Infinity, files: [] }, 'linux'), null);
    assert.equal(parseLinesAnswer({ work: 10 }, 'linux'), null);
    assert.equal(parseLinesAnswer('<html>', 'linux'), null);
  });

  it('matches a Windows editor path to the CLI form of it', () => {
    const windows = parseLinesAnswer({ work: 10, files: [{ file: 'C:/App/src/x.ts', lines: [[2, 5]] }, { file: 'C:\\App\\src\\X.ts', lines: [[2, 1]] }] }, 'win32');
    assert.ok(windows);
    const marks = hotMarks({ answer: windows, fileKey: pathKey('c:\\App\\src\\x.ts', 'win32'), minShare: 0 });
    assert.deepEqual(marks, [{ line: 2, share: 0.6, tier: 'hot' }]);
  });

  it('adds up the answers of several sessions', () => {
    assert.equal(mergeLinesAnswers([]), null);
    const other = parseLinesAnswer({ work: 1000, files: [{ file: '/srv/app/src/report.ts', lines: [[3, 100]] }, { file: '/srv/b.ts', lines: [[1, 50]] }] }, 'linux');
    assert.ok(answer && other);
    const merged = mergeLinesAnswers([answer, other]);
    assert.equal(merged?.work, 2000);
    assert.equal(merged?.files.get('/srv/app/src/report.ts')?.get(3), 500);
    assert.equal(merged?.files.get('/srv/b.ts')?.get(1), 50);
    assert.equal(answer.files.get('/srv/app/src/report.ts')?.get(3), 400);
  });
});

describe('forwardedHost', () => {
  it('names the host a forwarded dashboard is reached under, nothing for local ones', () => {
    assert.equal(forwardedHost('127.0.0.1:4800'), null);
    assert.equal(forwardedHost('localhost:4800'), null);
    assert.equal(forwardedHost('[::1]:4800'), null);
    assert.equal(forwardedHost('Fuzzy-Space-4800.app.github.dev'), 'fuzzy-space-4800.app.github.dev');
    assert.equal(forwardedHost('tunnel.example.com:8443'), 'tunnel.example.com:8443');
    assert.equal(forwardedHost(''), null);
  });
});
