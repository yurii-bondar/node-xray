// The webview: the CLI's dashboard in an iframe, a relay for "open this code" messages from it
// and for theme changes to it. Messages from the iframe are narrowed here before the extension
// acts on them.

export interface OpenRequest {
  /** `file://` URL or absolute path, as the dashboard has it. */
  readonly url: string;
  /** 1-based. */
  readonly line: number;
  readonly column: number;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** `{ type: 'xray.open', url, line, column }` from the webview → request; null for anything else. */
export function parseOpenRequest(value: unknown): OpenRequest | null {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'type') !== 'xray.open') return null;
  const url: unknown = Reflect.get(value, 'url');
  const line: unknown = Reflect.get(value, 'line');
  const column: unknown = Reflect.get(value, 'column');
  if (typeof url !== 'string' || url === '' || !isFiniteNumber(line) || !isFiniteNumber(column)) return null;
  return { url, line: Math.max(1, Math.floor(line)), column: Math.max(1, Math.floor(column)) };
}

/** `file:///a/My%20Dir/x.js` or `/a/My Dir/x.js` → `/a/My Dir/x.js`; null for anything that is not a local file. */
export function localFile(url: string): string | null {
  if (url.startsWith('file://')) {
    try {
      const path = decodeURIComponent(new URL(url).pathname);
      return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
    } catch {
      return null;
    }
  }
  return url.startsWith('/') || /^[A-Za-z]:[\\/]/.test(url) ? url : null;
}

export type Theme = 'light' | 'dark';

/** Sent to the webview on a theme change; its script hands it on to the dashboard. */
export interface ThemeMessage {
  readonly type: 'xray.theme';
  readonly theme: Theme;
}

/** Hosts the CLI's dashboard accepts without being told: a port forwarded to one of them needs nothing. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The `Host` a browser will send to the dashboard once VS Code forwarded its port (Codespaces,
 * remote tunnels), for `XRAY_DASHBOARD_HOST`; null when the address stays local.
 */
export function forwardedHost(authority: string): string | null {
  const host = authority.toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? '';
  return name === '' || LOCAL_HOSTS.has(name) ? null : host;
}

export interface DashboardUrlArgs {
  /** `http://127.0.0.1:<port>` of the CLI's dashboard server. */
  readonly base: string;
  readonly token: string;
  readonly theme: Theme;
}

/** The dashboard as the webview frames it; the webview's script adds `parent` (its own origin). */
export function dashboardUrl({ base, token, theme }: DashboardUrlArgs): string {
  const query = new URLSearchParams({ token, host: 'vscode', theme });
  return `${base}/?${query.toString()}`;
}

export interface DashboardPage {
  /** `dashboardUrl` as the webview can reach it (after `asExternalUri`). */
  readonly src: string;
  /** Its origin: the only one whose messages are relayed, and the only one messages go to. */
  readonly origin: string;
  readonly nonce: string;
}

function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** A JS literal safe inside `<script>`. */
function literal(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function dashboardHtml({ src, origin, nonce }: DashboardPage): string {
  const csp = `default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${attribute(csp)}">
<style>html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; }</style>
</head>
<body>
<iframe id="dashboard" title="xray dashboard"></iframe>
<script nonce="${attribute(nonce)}">
const vscode = acquireVsCodeApi();
const origin = ${literal(origin)};
const frame = document.getElementById('dashboard');
const src = new URL(${literal(src)});
src.searchParams.set('parent', location.origin);
frame.src = src.toString();
window.addEventListener('message', (event) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return;
  if (event.source === frame.contentWindow) {
    if (event.origin === origin && data.type === 'xray.open') vscode.postMessage({ type: data.type, url: data.url, line: data.line, column: data.column });
    return;
  }
  if (data.type === 'xray.theme' && (data.theme === 'light' || data.theme === 'dark')) frame.contentWindow.postMessage({ type: 'xray.theme', theme: data.theme }, origin);
});
</script>
</body>
</html>`;
}
