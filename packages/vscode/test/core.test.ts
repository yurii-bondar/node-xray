import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitCommand } from '../src/core/command.js';
import { hotMarks, markText, parseLinesAnswer, tierOf } from '../src/core/hot-lines.js';
import { looksLikeNode, parseNodeProcesses } from '../src/core/processes.js';
import { dashboardHtml, localFile, parseOpenRequest } from '../src/core/webview.js';

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
  });

  it('opens local files only', () => {
    assert.equal(localFile('file:///srv/My%20App/x.ts'), '/srv/My App/x.ts');
    assert.equal(localFile('file:///C:/app/x.ts'), 'C:/app/x.ts');
    assert.equal(localFile('/srv/app/x.ts'), '/srv/app/x.ts');
    assert.equal(localFile('node:internal/timers'), null);
    assert.equal(localFile('webpack://app/src/x.ts'), null);
  });

  it('frames the dashboard under a strict CSP and relays only its origin', () => {
    const html = dashboardHtml({ src: 'http://127.0.0.1:4000/?token=t&host=vscode', origin: 'http://127.0.0.1:4000', nonce: 'n0nce' });
    assert.match(html, /default-src 'none'; frame-src http:\/\/127\.0\.0\.1:4000; script-src 'nonce-n0nce'/);
    assert.match(html, /<iframe src="http:\/\/127\.0\.0\.1:4000\/\?token=t&amp;host=vscode"/);
    assert.match(html, /if \(event\.origin !== "http:\/\/127\.0\.0\.1:4000"\) return;/);
  });
});

describe('hot lines', () => {
  const answer = parseLinesAnswer({
    work: 1000,
    files: [
      { file: '/srv/app/src/report.ts', lines: [[3, 400], [7, 30], [9, 2], ['x', 1]] },
      { file: 7, lines: [] },
    ],
  });

  it('reads the CLI answer and marks lines above the threshold, heaviest first', () => {
    assert.ok(answer);
    assert.equal(answer.files.size, 1);
    const marks = hotMarks(answer, '/srv/app/src/report.ts', 0.005);
    assert.deepEqual(marks.map((m) => [m.line, m.tier]), [
      [3, 'hot'],
      [7, 'warm'],
    ]);
    assert.equal(markText(marks[0] ?? { line: 0, share: 0, tier: 'mild' }), '40.0 % CPU');
    assert.deepEqual(hotMarks(answer, '/elsewhere.ts', 0), []);
    assert.equal(tierOf(0.003), 'mild');
    assert.equal(parseLinesAnswer({ work: 'x' }), null);
  });
});
