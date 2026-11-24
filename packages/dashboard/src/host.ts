// The page inside the VS Code extension's webview: what the extension says, narrowed here.
// The iframe URL carries `parent=<webview origin>` and `theme=light|dark`; later theme changes
// arrive as `{ type: 'xray.theme', theme }` messages from that origin. No DOM here.

export type Theme = 'light' | 'dark';

export function parseTheme(value: unknown): Theme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

/** The theme of an `xray.theme` message; null for anything else. */
export function parseThemeMessage(data: unknown): Theme | null {
  if (typeof data !== 'object' || data === null || Reflect.get(data, 'type') !== 'xray.theme') return null;
  return parseTheme(Reflect.get(data, 'theme'));
}
