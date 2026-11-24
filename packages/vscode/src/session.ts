// One xray run or attach inside VS Code: the CLI in a terminal (so the program's output and
// Ctrl+C work as usual), its dashboard in a webview, hot lines in the editors.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { hotMarks, markText, mergeLinesAnswers, parseLinesAnswer, type HotTier, type LinesAnswer } from './core/hot-lines.js';
import { mayOpen, pathKey } from './core/paths.js';
import { readSettings, type XraySettings } from './core/settings.js';
import { MIN_NODE_MAJOR, nodeMajor, parseRunStatus, programDone, type RunStatus } from './core/status.js';
import { dashboardHtml, dashboardUrl, forwardedHost, localFile, parseOpenRequest, type Theme, type ThemeMessage } from './core/webview.js';

const READY_TIMEOUT_MS = 20_000;
const POLL_MS = 2000;
const STOP_POLL_MS = 250;
/** How long a program may take to shut down before the second Ctrl+C goes out anyway. */
const STOP_TIMEOUT_MS = 30_000;

export type Target =
  | { readonly kind: 'run'; readonly program: string; readonly args: readonly string[]; readonly cwd: string | undefined; readonly label: string }
  | { readonly kind: 'attach'; readonly pid: number; readonly label: string };

export interface SessionArgs {
  readonly target: Target;
  /** The bundled CLI (`dist/xray/cli.mjs`). */
  readonly cli: string;
  readonly hotLines: HotLineDecorations;
  readonly onEnd: (session: XraySession) => void;
}

export function settings(): XraySettings {
  const config = vscode.workspace.getConfiguration('xray');
  return readSettings((key) => config.get(key));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Fails with a message worth showing when `node` cannot run xray, before a terminal opens. */
async function checkNode(node: string): Promise<void> {
  let output: string;
  try {
    ({ stdout: output } = await promisify(execFile)(node, ['--version'], { timeout: 10_000 }));
  } catch (error) {
    throw new Error(`cannot run "${node}" (setting xray.nodePath): ${error instanceof Error ? error.message : String(error)}`);
  }
  const major = nodeMajor(output);
  if (major === null || major < MIN_NODE_MAJOR) {
    throw new Error(`xray needs Node.js ${MIN_NODE_MAJOR} or newer to run, "${node}" is ${output.trim() || 'not Node.js'}. Install it or point the setting xray.nodePath at it; the profiled program can use Node.js 20.`);
  }
}

function currentTheme(): Theme {
  const { kind } = vscode.window.activeColorTheme;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
}

/** The three decoration styles and the marks they show: the latest answers of all live sessions, added up. */
export class HotLineDecorations implements vscode.Disposable {
  readonly #types: Record<HotTier, vscode.TextEditorDecorationType>;
  readonly #answers = new Map<XraySession, LinesAnswer>();
  #merged: LinesAnswer | null = null;

  constructor() {
    const after = (color: string): vscode.ThemableDecorationAttachmentRenderOptions => ({ color: new vscode.ThemeColor(color), margin: '0 0 0 2em', fontStyle: 'italic' });
    this.#types = {
      hot: vscode.window.createTextEditorDecorationType({
        after: after('errorForeground'),
        backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
        overviewRulerColor: new vscode.ThemeColor('errorForeground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        isWholeLine: true,
      }),
      warm: vscode.window.createTextEditorDecorationType({ after: after('editorWarning.foreground'), overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'), overviewRulerLane: vscode.OverviewRulerLane.Right }),
      mild: vscode.window.createTextEditorDecorationType({ after: after('editorCodeLens.foreground') }),
    };
  }

  /** Replaces the session's previous answer. */
  set(session: XraySession, answer: LinesAnswer): void {
    this.#answers.set(session, answer);
    this.#update();
  }

  drop(session: XraySession): void {
    if (this.#answers.delete(session)) this.#update();
  }

  /** Until a session's answer changes again. */
  clear(): void {
    this.#answers.clear();
    this.#update();
  }

  /** Re-applies to the visible editors (also when they change). */
  refresh(): void {
    const minShare = settings().hotLineShare;
    for (const editor of vscode.window.visibleTextEditors) {
      const { uri } = editor.document;
      const marks = this.#merged === null || uri.scheme !== 'file' ? [] : hotMarks({ answer: this.#merged, fileKey: pathKey(uri.fsPath, process.platform), minShare });
      const byTier: Record<HotTier, vscode.DecorationOptions[]> = { hot: [], warm: [], mild: [] };
      for (const mark of marks) {
        if (mark.line > editor.document.lineCount) continue;
        const line = editor.document.lineAt(mark.line - 1);
        byTier[mark.tier].push({
          range: line.range,
          hoverMessage: `xray: ${(mark.share * 100).toFixed(2)} % of CPU work on this line, since profiling started`,
          renderOptions: { after: { contentText: markText(mark) } },
        });
      }
      for (const tier of ['hot', 'warm', 'mild'] as const) editor.setDecorations(this.#types[tier], byTier[tier]);
    }
  }

  dispose(): void {
    for (const type of Object.values(this.#types)) type.dispose();
  }

  #update(): void {
    this.#merged = mergeLinesAnswers(this.#answers.values());
    this.refresh();
  }
}

interface SessionParts {
  readonly label: string;
  readonly terminal: vscode.Terminal;
  /** `http://127.0.0.1:<port>` of the CLI's dashboard server. */
  readonly base: string;
  readonly token: string;
  readonly args: SessionArgs;
}

export class XraySession implements vscode.Disposable {
  readonly label: string;
  readonly #disposables: vscode.Disposable[] = [];
  readonly #terminal: vscode.Terminal;
  readonly #base: string;
  readonly #token: string;
  readonly #args: SessionArgs;
  /** `pathKey`s of every file `/api/lines` named: the program's own code, which the dashboard may open. */
  readonly #seen = new Set<string>();
  #panel: vscode.WebviewPanel | null = null;
  /** The last `/api/lines` body, to leave the decorations alone while it does not change. */
  #lastLines: string | null = null;
  #stopping = false;
  #ended = false;

  private constructor({ label, terminal, base, token, args }: SessionParts) {
    this.label = label;
    this.#terminal = terminal;
    this.#base = base;
    this.#token = token;
    this.#args = args;
  }

  static async start(args: SessionArgs): Promise<XraySession> {
    const config = settings();
    await checkNode(config.nodePath);
    const port = await freePort();
    const token = randomBytes(18).toString('base64url');
    const collect = [...(config.cpu ? ['--cpu'] : []), ...(config.heap ? ['--heap'] : []), ...(config.fs ? ['--fs'] : [])];
    const { target } = args;
    const cliArgs =
      target.kind === 'run'
        ? [args.cli, 'run', '--port', String(port), ...collect, '--', target.program, ...target.args]
        : [args.cli, 'attach', '--port', String(port), ...collect, String(target.pid)];
    // Remote windows (Codespaces, tunnels) forward the port under another host name; the CLI
    // rejects unknown Host headers unless told this one.
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${port}`));
    const host = forwardedHost(external.authority);
    // The terminal runs xray itself, no shell: no quoting to get wrong, Ctrl+C reaches it. Transient:
    // a window reload must not bring back a terminal no session owns.
    const terminal = vscode.window.createTerminal({
      name: `xray: ${target.label}`,
      shellPath: config.nodePath,
      shellArgs: cliArgs,
      ...(target.kind === 'run' && target.cwd !== undefined ? { cwd: target.cwd } : {}),
      env: { XRAY_DASHBOARD_TOKEN: token, ...(host === null ? {} : { XRAY_DASHBOARD_HOST: host }) },
      isTransient: true,
    });
    terminal.show(true);
    const session = new XraySession({ label: target.label, terminal, base: `http://127.0.0.1:${port}`, token, args });
    session.#disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed === terminal) session.#end();
      }),
    );
    try {
      await session.#waitForDashboard();
      await session.showDashboard();
    } catch (error) {
      // Nothing outlives a failed start: a CLI still running is stopped with its terminal; the
      // terminal of one that exited stays, its output says why.
      if (terminal.exitStatus === undefined) terminal.dispose();
      session.dispose();
      throw error;
    }
    void session.#poll();
    return session;
  }

  /** Opens (or reveals) the dashboard webview; it closes with the session. */
  async showDashboard(): Promise<void> {
    if (this.#reveal()) return;
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(dashboardUrl({ base: this.#base, token: this.#token, theme: currentTheme() })));
    // Another call may have opened it meanwhile.
    if (this.#ended || this.#reveal()) return;
    const panel = vscode.window.createWebviewPanel('xray.dashboard', `xray: ${this.label}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    panel.webview.html = dashboardHtml({ src: external.toString(true), origin: `${external.scheme}://${external.authority}`, nonce: randomBytes(16).toString('base64') });
    const owned: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage((message: unknown) => void this.#open(message)),
      vscode.window.onDidChangeActiveColorTheme(() => {
        const message: ThemeMessage = { type: 'xray.theme', theme: currentTheme() };
        void panel.webview.postMessage(message);
      }),
    ];
    panel.onDidDispose(() => {
      for (const disposable of owned.splice(0)) disposable.dispose();
      if (this.#panel === panel) this.#panel = null;
    });
    this.#panel = panel;
  }

  /**
   * Ctrl+C in the terminal: a run stops the program (then xray, after its summary), an attach
   * detaches and closes the inspector. Once xray says the program is done, a second one ends
   * xray, whose dashboard waits otherwise. Never earlier: it would cut the program's own shutdown.
   */
  async stop(): Promise<void> {
    if (this.#gone() || this.#stopping) return;
    this.#stopping = true;
    try {
      const before = await this.#status();
      this.#terminal.sendText('\u0003', false);
      // Only the dashboard was left: that Ctrl+C ends xray.
      if (before !== null && programDone(before)) return;
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (!this.#gone() && Date.now() < deadline) {
        await sleep(STOP_POLL_MS);
        const status = await this.#status();
        if (status !== null && programDone(status)) break;
      }
      if (!this.#gone()) this.#terminal.sendText('\u0003', false);
    } finally {
      this.#stopping = false;
    }
  }

  get ended(): boolean {
    return this.#ended;
  }

  dispose(): void {
    this.#end();
  }

  #reveal(): boolean {
    this.#panel?.reveal(vscode.ViewColumn.Beside);
    return this.#panel !== null;
  }

  #gone(): boolean {
    return this.#ended || this.#terminal.exitStatus !== undefined;
  }

  /** Ready once `/api/lines` answers as xray's server does: anything else on the port is not ours. */
  async #waitForDashboard(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.#gone()) {
        const code = this.#terminal.exitStatus?.code;
        throw new Error(`xray stopped${code === undefined ? '' : ` (exit code ${code})`} before its dashboard came up: see its terminal`);
      }
      const body = await this.#get('/api/lines', 1000);
      if (body !== null && this.#takeLines(body)) return;
      await sleep(200);
    }
    throw new Error(`xray's dashboard did not come up within ${READY_TIMEOUT_MS / 1000} s, so xray was stopped`);
  }

  /** Hot lines every 2 s while the program runs, once more after it is done, then no more: they cannot change. */
  async #poll(): Promise<void> {
    while (!this.#ended) {
      const status = await this.#status();
      const body = await this.#get('/api/lines', 1500);
      if (body !== null) this.#takeLines(body);
      if (status !== null && programDone(status)) return;
      await sleep(POLL_MS);
    }
  }

  /** Shows a `/api/lines` body unless it is the last one again; false when it is not one. */
  #takeLines(body: string): boolean {
    if (body === this.#lastLines) return true;
    const answer = parseLinesAnswer(parseJson(body), process.platform);
    if (answer === null) return false;
    this.#lastLines = body;
    for (const file of answer.files.keys()) this.#seen.add(file);
    if (!this.#ended) this.#args.hotLines.set(this, answer);
    return true;
  }

  /** Null when xray does not say (not up, gone, or a CLI without `/api/status`). */
  async #status(): Promise<RunStatus | null> {
    const body = await this.#get('/api/status', 1500);
    return body === null ? null : parseRunStatus(parseJson(body));
  }

  /** The body of a JSON 200 from xray's API; null for anything else. */
  async #get(pathname: string, timeoutMs: number): Promise<string | null> {
    try {
      const response = await fetch(`${this.#base}${pathname}?token=${encodeURIComponent(this.#token)}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.status !== 200 || !(response.headers.get('content-type') ?? '').startsWith('application/json')) {
        await response.body?.cancel();
        return null;
      }
      return await response.text();
    } catch {
      return null; // not listening (yet or any more)
    }
  }

  async #open(message: unknown): Promise<void> {
    const request = parseOpenRequest(message);
    if (request === null) return;
    const file = localFile(request.url);
    if (file === null) return;
    const roots = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
    const { target } = this.#args;
    if (target.kind === 'run' && target.cwd !== undefined) roots.push(target.cwd);
    if (!mayOpen(file, { seen: this.#seen, roots, platform: process.platform })) {
      void vscode.window.showWarningMessage(`xray: not opening ${file}: it is neither in the workspace nor code xray profiled`);
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const position = document.validatePosition(new vscode.Position(request.line - 1, request.column - 1));
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(position, position) });
    } catch {
      void vscode.window.showWarningMessage(`xray: cannot open ${file}`);
    }
  }

  /** The terminal closed (xray is gone, so is its dashboard), or the extension shuts down. */
  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#args.hotLines.drop(this);
    this.#panel?.dispose();
    for (const disposable of this.#disposables.splice(0)) disposable.dispose();
    this.#args.onEnd(this);
  }
}
