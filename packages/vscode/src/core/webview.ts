// The webview: the CLI's dashboard in an iframe, and a relay for "open this code" messages.
// Messages from the iframe are narrowed here before the extension acts on them.

export interface OpenRequest {
  /** `file://` URL or absolute path, as the dashboard has it. */
  readonly url: string;
  /** 1-based. */
  readonly line: number;
  readonly column: number;
}

/** `{ type: 'xray.open', url, line, column }` from the webview → request; null for anything else. */
export function parseOpenRequest(value: unknown): OpenRequest | null {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'type') !== 'xray.open') return null;
  const url: unknown = Reflect.get(value, 'url');
  const line: unknown = Reflect.get(value, 'line');
  const column: unknown = Reflect.get(value, 'column');
  if (typeof url !== 'string' || url === '' || typeof line !== 'number' || typeof column !== 'number') return null;
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

export interface DashboardPage {
  /** The dashboard URL the webview can reach (after `asExternalUri`), token included. */
  readonly src: string;
  /** Its origin, the only one whose messages are relayed. */
  readonly origin: string;
  readonly nonce: string;
}

function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
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
<iframe src="${attribute(src)}" title="xray dashboard"></iframe>
<script nonce="${attribute(nonce)}">
const vscode = acquireVsCodeApi();
window.addEventListener('message', (event) => {
  if (event.origin !== ${JSON.stringify(origin)}) return;
  if (event.data && event.data.type === 'xray.open') vscode.postMessage(event.data);
});
</script>
</body>
</html>`;
}
