// Wires the commands, the status bar item and the hot-line decorations. Logic lives in
// src/core (no vscode) and src/session.ts.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { splitCommand } from './core/command.js';
import { parseNodeProcesses } from './core/processes.js';
import { HotLineDecorations, XraySession, type Target } from './session.js';

const RUNNABLE = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

export function activate(context: vscode.ExtensionContext): void {
  const cli = context.asAbsolutePath(path.join('dist', 'xray', 'cli.mjs'));
  const hotLines = new HotLineDecorations();
  const sessions = new Set<XraySession>();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'xray.show';

  const updateStatus = (): void => {
    if (sessions.size === 0) {
      status.hide();
      return;
    }
    status.text = `$(pulse) xray${sessions.size > 1 ? ` ×${sessions.size}` : ''}`;
    status.tooltip = `xray: ${[...sessions].map((s) => s.label).join(', ')}. Click for the dashboard.`;
    status.show();
  };

  const start = async (target: Target): Promise<void> => {
    try {
      const session = await XraySession.start({
        target,
        cli,
        hotLines,
        onEnd: (ended) => {
          sessions.delete(ended);
          updateStatus();
        },
      });
      sessions.add(session);
      updateStatus();
    } catch (error) {
      void vscode.window.showErrorMessage(`xray: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const pick = async (placeHolder: string): Promise<XraySession | undefined> => {
    const live = [...sessions];
    if (live.length <= 1) return live[0];
    const chosen = await vscode.window.showQuickPick(
      live.map((session) => ({ label: session.label, session })),
      { placeHolder },
    );
    return chosen?.session;
  };

  context.subscriptions.push(
    hotLines,
    status,
    vscode.window.onDidChangeVisibleTextEditors(() => hotLines.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('xray.hotLineThreshold')) hotLines.refresh();
    }),

    vscode.commands.registerCommand('xray.profileFile', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document === undefined || document.uri.scheme !== 'file' || !RUNNABLE.has(path.extname(document.uri.fsPath))) {
        void vscode.window.showWarningMessage('xray: open a .js or .ts file to profile it.');
        return;
      }
      if (document.isDirty) await document.save();
      const file = document.uri.fsPath;
      const cwd = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? path.dirname(file);
      const node = vscode.workspace.getConfiguration('xray').get<string>('nodePath', 'node');
      await start({ kind: 'run', program: node, args: [file], cwd, label: path.basename(file) });
    }),

    vscode.commands.registerCommand('xray.run', async () => {
      const last = context.workspaceState.get<string>('xray.lastCommand', 'npm start');
      const text = await vscode.window.showInputBox({ prompt: 'Command to profile (its Node.js processes get the xray agent)', value: last });
      if (text === undefined) return;
      const command = splitCommand(text);
      if (command === null) {
        void vscode.window.showErrorMessage('xray: that command has an unclosed quote.');
        return;
      }
      await context.workspaceState.update('xray.lastCommand', text);
      await start({ kind: 'run', program: command.program, args: command.args, cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, label: text });
    }),

    vscode.commands.registerCommand('xray.attach', async () => {
      let candidates: Array<vscode.QuickPickItem & { pid: number }> = [];
      if (process.platform !== 'win32') {
        try {
          const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pid=,args='], { timeout: 3000 });
          candidates = parseNodeProcesses(stdout, new Set([process.pid])).map((p) => ({ label: String(p.pid), description: p.args, pid: p.pid }));
        } catch {
          candidates = [];
        }
      }
      const typed: vscode.QuickPickItem & { pid: number } = { label: 'Enter a pid…', pid: 0 };
      const chosen = await vscode.window.showQuickPick([...candidates, typed], { placeHolder: 'Node.js process to attach to (its inspector opens while attached)', matchOnDescription: true });
      if (chosen === undefined) return;
      let pid = chosen.pid;
      if (pid === 0) {
        const text = await vscode.window.showInputBox({ prompt: 'Process id', validateInput: (v) => (/^\d+$/.test(v.trim()) ? null : 'a number') });
        if (text === undefined) return;
        pid = Number(text.trim());
      }
      await start({ kind: 'attach', pid, label: `pid ${pid}${chosen.description ? ` ${chosen.description}` : ''}` });
    }),

    vscode.commands.registerCommand('xray.show', async () => {
      const session = await pick('Dashboard of…');
      await session?.showDashboard();
    }),

    vscode.commands.registerCommand('xray.stop', async () => {
      const session = await pick('Stop…');
      await session?.stop();
    }),

    vscode.commands.registerCommand('xray.clearHotLines', () => hotLines.show(null)),

    { dispose: () => [...sessions].forEach((session) => session.dispose()) },
  );
}

export function deactivate(): void {
  // Sessions are disposed with the extension's subscriptions.
}
