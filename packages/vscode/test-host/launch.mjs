// Starts VS Code with this extension in development mode and an isolated profile, runs
// test-host/run.cjs, and prints what it saw. Needs a local VS Code (VSCODE_BIN or the macOS default).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = process.env.VSCODE_BIN ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const dir = mkdtempSync(path.join(os.tmpdir(), 'xray-e2e-'));
const app = path.join(dir, 'xray-e2e-app.cjs');
writeFileSync(app, 'function crunch() { let x = 0; for (let i = 0; i < 2e6; i++) x += Math.sqrt(i); return x; }\nsetInterval(crunch, 20);\n');
const out = path.join(dir, 'result.json');
const child = spawn(code, [
  `--user-data-dir=${path.join(dir, 'user')}`,
  `--extensions-dir=${path.join(dir, 'extensions')}`,
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  `--extensionDevelopmentPath=${path.resolve(here, '..')}`,
  `--extensionTestsPath=${path.join(here, 'run.cjs')}`,
  dir,
], { stdio: 'ignore', env: { ...process.env, XRAY_E2E_FILE: app, XRAY_E2E_OUT: out } });
const code_ = await new Promise((resolve) => child.on('exit', resolve));
let result = 'no result';
try {
  result = readFileSync(out, 'utf8');
} catch {
  // the host test did not get to write it: 'no result' says so
}
console.log(`VS Code exited ${code_}\n${result}`);
rmSync(dir, { recursive: true, force: true });
