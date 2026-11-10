// Runs inside a real VS Code (Extension Development Host, isolated profile): drives the commands
// and writes what it saw to XRAY_E2E_OUT. Started by test-host/launch.mjs, not by `npm test`.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async function run() {
  const seen = {};
  try {
    const extension = vscode.extensions.getExtension('bondevn.node-xray');
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    seen.commands = commands.filter((c) => c.startsWith('xray.')).sort();

    const document = await vscode.workspace.openTextDocument(process.env.XRAY_E2E_FILE);
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('xray.profileFile');
    const terminal = vscode.window.terminals.find((t) => t.name.startsWith('xray: '));
    seen.terminal = terminal ? terminal.name : null;

    const ps = execFileSync('ps', ['-ww', '-A', '-o', 'args=']).toString();
    const line = ps.split('\n').find((l) => l.includes('cli.mjs run --port'));
    seen.psLine = line ? line.slice(-160) : null;
    const portMatch = line ? /--port\s+(\d+)/.exec(line) : null;
    const port = portMatch ? Number(portMatch[1]) : 0;
    seen.cli = line ? line.replace(/^.*cli\.mjs/, 'cli.mjs') : null;
    seen.dashboard = port ? (await fetch(`http://127.0.0.1:${port}/`)).status : null;
    seen.tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));

    await sleep(3000);
    await vscode.commands.executeCommand('xray.stop');
    for (let i = 0; i < 40 && terminal && terminal.exitStatus === undefined; i++) await sleep(250);
    seen.exit = terminal && terminal.exitStatus ? terminal.exitStatus.code : 'running';
    const after = execFileSync('ps', ['-ww', '-A', '-o', 'args=']).toString();
    seen.leftOver = after.split('\n').filter((l) => l.includes('cli.mjs run --port') || l.includes('xray-e2e-app')).length;
    assert.ok(seen.terminal);
  } catch (error) {
    seen.error = String(error && error.stack || error);
  } finally {
    fs.writeFileSync(process.env.XRAY_E2E_OUT, JSON.stringify(seen, null, 2));
  }
};
