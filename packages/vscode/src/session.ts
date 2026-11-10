// One xray run or attach inside VS Code: the CLI in a terminal (so the program's output and
// Ctrl+C work as usual), its dashboard in a webview, hot lines in the editors.

import { randomBytes } from 'node:crypto';
import net from 'node:net';
import * as vscode from 'vscode';
import { hotMarks, markText, parseLinesAnswer, type HotTier, type LinesAnswer } from './core/hot-lines.js';
import { dashboardHtml, localFile, parseOpenRequest } from './core/webview.js';

const READY_TIMEOUT_MS = 20_000;
const LINES_POLL_MS = 2000;

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

/** The three decoration styles and the marks they currently show. */
export class HotLineDecorations implements vscode.Disposable {
  readonly #types: Record<HotTier, vscode.TextEditorDecorationType>;
  #answer: LinesAnswer | null = null;

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

  show(answer: LinesAnswer | null): void {
    this.#answer = answer;
    this.refresh();
  }

  /** Re-applies to the visible editors (also when they change). */
  refresh(): void {
    const threshold = vscode.workspace.getConfiguration('xray').get<number>('hotLineThreshold', 0.5) / 100;
    for (const editor of vscode.window.visibleTextEditors) {
      const marks = this.#answer === null || editor.document.uri.scheme !== 'file' ? [] : hotMarks(this.#answer, editor.document.uri.fsPath, threshold);
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
  #panel: vscode.WebviewPanel | null = null;
  #poller: NodeJS.Timeout | null = null;
  #ended = false;

  private constructor({ label, terminal, base, token, args }: SessionParts) {
    this.label = label;
    this.#terminal = terminal;
    this.#base = base;
    this.#token = token;
    this.#args = args;
  }

  static async start(args: SessionArgs): Promise<XraySession> {
    const config = vscode.workspace.getConfiguration('xray');
    const node = config.get<string>('nodePath', 'node');
    const port = await freePort();
    const token = randomBytes(18).toString('base64url');
    const collect = [
      ...(config.get<boolean>('cpu', true) ? ['--cpu'] : []),
      ...(config.get<boolean>('heap', false) ? ['--heap'] : []),
      ...(config.get<boolean>('fs', false) ? ['--fs'] : []),
    ];
    const { target } = args;
    const cliArgs =
      target.kind === 'run'
        ? [args.cli, 'run', '--port', String(port), ...collect, '--', target.program, ...target.args]
        : [args.cli, 'attach', '--port', String(port), ...collect, String(target.pid)];
    // The terminal runs xray itself, no shell: no quoting to get wrong, Ctrl+C reaches it.
    const terminal = vscode.window.createTerminal({
      name: `xray: ${target.label}`,
      shellPath: node,
      shellArgs: cliArgs,
      ...(target.kind === 'run' && target.cwd !== undefined ? { cwd: target.cwd } : {}),
      env: { XRAY_DASHBOARD_TOKEN: token },
    });
    terminal.show(true);
    const session = new XraySession({ label: target.label, terminal, base: `http://127.0.0.1:${port}`, token, args });
    session.#disposables.push(
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed === terminal) session.#end();
      }),
    );
    await session.#waitForDashboard();
    await session.showDashboard();
    session.#poller = setInterval(() => void session.#pollLines(), LINES_POLL_MS);
    return session;
  }

  /** Opens (or reveals) the dashboard webview. */
  async showDashboard(): Promise<void> {
    if (this.#panel !== null) {
      this.#panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(`${this.#base}/?token=${this.#token}&host=vscode`));
    const panel = vscode.window.createWebviewPanel('xray.dashboard', `xray: ${this.label}`, vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    panel.webview.html = dashboardHtml({ src: external.toString(true), origin: `${external.scheme}://${external.authority}`, nonce: randomBytes(16).toString('base64') });
    panel.webview.onDidReceiveMessage((message: unknown) => void this.#open(message), undefined, this.#disposables);
    panel.onDidDispose(() => (this.#panel = null), undefined, this.#disposables);
    this.#panel = panel;
  }

  /**
   * Ctrl+C in the terminal: a run stops the program (then xray, after its summary), an attach
   * detaches and closes the inspector. A second one ends xray, whose dashboard waits otherwise.
   */
  async stop(): Promise<void> {
    if (this.#ended) return;
    this.#terminal.sendText('\u0003', false);
    await sleep(2500);
    if (!this.#ended) this.#terminal.sendText('\u0003', false);
  }

  get ended(): boolean {
    return this.#ended;
  }

  dispose(): void {
    this.#end();
    this.#panel?.dispose();
  }

  async #waitForDashboard(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline && !this.#ended) {
      try {
        if ((await fetch(`${this.#base}/`, { signal: AbortSignal.timeout(1000) })).ok) return;
      } catch {
        // not listening yet
      }
      await sleep(200);
    }
    throw new Error(this.#ended ? 'xray stopped before its dashboard came up: see its terminal' : 'the dashboard did not come up in time: see the xray terminal');
  }

  async #pollLines(): Promise<void> {
    try {
      const response = await fetch(`${this.#base}/api/lines?token=${encodeURIComponent(this.#token)}`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return;
      const answer = parseLinesAnswer(await response.json());
      if (answer !== null) this.#args.hotLines.show(answer);
    } catch {
      // xray is finishing or gone; the terminal close ends the session
    }
  }

  async #open(message: unknown): Promise<void> {
    const request = parseOpenRequest(message);
    if (request === null) return;
    const file = localFile(request.url);
    if (file === null) return;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const position = new vscode.Position(Math.min(request.line, document.lineCount) - 1, request.column - 1);
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(position, position) });
    } catch {
      void vscode.window.showWarningMessage(`xray: cannot open ${file}`);
    }
  }

  #end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#poller !== null) clearInterval(this.#poller);
    this.#poller = null;
    for (const disposable of this.#disposables.splice(0)) disposable.dispose();
    this.#args.onEnd(this);
  }
}
