import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cmdArgument, cmdLine, resolveWindowsCommand, windowsSpawnPlan, type WindowsShell } from '../src/command.js';

/** Lower case: Windows file names are case-insensitive. */
const FILES = new Set(['C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\tools\\yarn.CMD', 'C:\\app\\local.bat', 'C:\\app\\bin\\serve.cmd'].map((file) => file.toLowerCase()));

const shell: WindowsShell = {
  path: 'C:\\Windows\\system32;"C:\\Program Files\\nodejs";;C:\\tools',
  pathext: '.COM;.EXE;.BAT;.CMD',
  cwd: 'C:\\app',
  comspec: 'C:\\Windows\\system32\\cmd.exe',
  isFile: (file) => FILES.has(file.toLowerCase()),
};

/**
 * What cmd.exe and then the program do with a `/d /s /c` line for a batch shim that passes `%*`
 * on: `/s` strips the outer quotes; phase 1 expands `%name%` of defined variables; carets make the
 * next character literal and unescaped spaces end the command name; the shim's `%*` goes through
 * the caret pass once more; the program splits it by the C runtime rules.
 */
function simulate(line: string, env: ReadonlyMap<string, string>): { file: string; args: string[] } {
  assert.ok(line.startsWith('"') && line.endsWith('"'));
  const inner = line.slice(1, -1).replace(/%([^%]+)%/g, (whole, name: string) => env.get(name) ?? whole);
  let file = '';
  let i = 0;
  for (; i < inner.length; i++) {
    const c = inner[i];
    if (c === '^') file += inner[++i] ?? '';
    else if (c === ' ') break;
    else if (c === '"' || c === '&' || c === '|' || c === '<' || c === '>') assert.fail(`unescaped ${c} at ${i} in ${inner}`);
    else file += c;
  }
  const once = carets(inner.slice(i + 1));
  return { file, args: crtSplit(carets(once)) };
}

function carets(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '^') out += text[++i] ?? '';
    else if (c === '"' || c === '&' || c === '|' || c === '<' || c === '>') assert.fail(`unescaped ${c} at ${i} in ${text}`);
    else out += c;
  }
  return out;
}

function crtSplit(text: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (i >= text.length) break;
    let arg = '';
    let quoted = false;
    for (; i < text.length; ) {
      const c = text[i];
      if (c === '\\') {
        let n = 0;
        while (text[i] === '\\') {
          n++;
          i++;
        }
        if (text[i] === '"') {
          arg += '\\'.repeat(Math.floor(n / 2));
          if (n % 2 === 1) {
            arg += '"';
            i++;
          }
        } else arg += '\\'.repeat(n);
        continue;
      }
      if (c === '"') {
        if (quoted && text[i + 1] === '"') {
          arg += '"';
          i += 2;
        } else {
          quoted = !quoted;
          i++;
        }
        continue;
      }
      if ((c === ' ' || c === '\t') && !quoted) break;
      arg += c;
      i++;
    }
    args.push(arg);
  }
  return args;
}

describe('resolveWindowsCommand', () => {
  it('searches the current directory, then PATH, with PATHEXT', () => {
    assert.equal(resolveWindowsCommand('npm', shell), 'C:\\Program Files\\nodejs\\npm.cmd');
    assert.equal(resolveWindowsCommand('node', shell), 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(resolveWindowsCommand('yarn', shell), 'C:\\tools\\yarn.cmd', 'extension case does not matter');
    assert.equal(resolveWindowsCommand('local', shell), 'C:\\app\\local.bat', 'the current directory first');
    assert.equal(resolveWindowsCommand('npm.cmd', shell), 'C:\\Program Files\\nodejs\\npm.cmd');
    assert.equal(resolveWindowsCommand('bin\\serve', shell), 'C:\\app\\bin\\serve.cmd', 'a relative path is not searched on PATH');
    assert.equal(resolveWindowsCommand('C:\\tools\\yarn.CMD', shell), 'C:\\tools\\yarn.CMD');
    assert.ok(/\.cmd$/i.test(windowsSpawnPlan('yarn', [], shell).args[3]?.slice(0, -1) ?? ''), 'yarn goes through cmd.exe');
    assert.equal(resolveWindowsCommand('nope', shell), null);
    assert.equal(resolveWindowsCommand('npm', { ...shell, pathext: '' }), 'C:\\Program Files\\nodejs\\npm.cmd', 'default PATHEXT');
  });
});

describe('windowsSpawnPlan', () => {
  it('runs batch files through cmd.exe and everything else as given', () => {
    const npm = windowsSpawnPlan('npm', ['run', 'start'], shell);
    assert.equal(npm.file, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepEqual(npm.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(npm.verbatim, true);
    assert.equal(npm.args[3], '"C:\\Program^ Files\\nodejs\\npm.cmd ^^^"run^^^" ^^^"start^^^""');
    assert.deepEqual(windowsSpawnPlan('node', ['app.js'], shell), { file: 'node', args: ['app.js'], verbatim: false });
    assert.deepEqual(windowsSpawnPlan('missing', ['x'], shell), { file: 'missing', args: ['x'], verbatim: false }, 'ENOENT is reported as before');
  });
});

describe('cmd.exe escaping', () => {
  it('escapes every meta character', () => {
    assert.equal(cmdArgument('a b'), '^^^"a^^^ b^^^"');
    assert.equal(cmdArgument('a&b'), '^^^"a^^^&b^^^"');
    assert.equal(cmdArgument('%PATH%'), '^^^"^^^%PATH^^^%^^^"');
    assert.equal(cmdArgument('say "hi"'), '^^^"say^^^ \\^^^"hi\\^^^"^^^"');
    assert.equal(cmdArgument(''), '^^^"^^^"');
    assert.equal(cmdLine('C:\\a b\\x.cmd', []), '"C:\\a^ b\\x.cmd"');
  });

  it('round-trips through cmd.exe, a %* shim and the C runtime', () => {
    const env = new Map([
      ['PATH', 'C:\\Windows'],
      ['HOME', 'C:\\Users\\me'],
    ]);
    const args = [
      'plain',
      'with space',
      '  leading and trailing  ',
      '',
      'quote"inside',
      '"quoted"',
      'trailing\\',
      'trailing\\\\',
      'back\\"slash',
      'C:\\Program Files\\x\\',
      '%PATH%',
      '%HOME% and %NOPE%',
      '100%',
      '^caret^^',
      'a&b',
      'a && b',
      'a|b',
      '<in',
      '>out',
      '2>&1',
      '(x)',
      '!bang!',
      'a,b;c=d',
      '`tick` *star* ?q',
      '--flag="a b" & echo pwned | more > out < in ^ %PATH%',
      'ünïcödé ✓',
    ];
    const line = cmdLine('C:\\Program Files\\nodejs\\npm.cmd', args);
    const parsed = simulate(line, env);
    assert.equal(parsed.file, 'C:\\Program Files\\nodejs\\npm.cmd');
    assert.deepEqual(parsed.args, args);
  });
});
