// The CLI's `GET /api/status` answer (the same shape as the dashboard's SSE `status` event), and
// the Node.js that is to run the CLI.

export type RunState = 'running' | 'exited' | 'detached' | 'replay';

export interface RunStatus {
  readonly state: RunState;
  readonly command: string;
  /** Exit code once the program exited, when it had one. */
  readonly code?: number;
}

const STATES: ReadonlySet<string> = new Set<RunState>(['running', 'exited', 'detached', 'replay']);

const isState = (value: unknown): value is RunState => typeof value === 'string' && STATES.has(value);

export function parseRunStatus(value: unknown): RunStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const state: unknown = Reflect.get(value, 'state');
  const command: unknown = Reflect.get(value, 'command');
  const code: unknown = Reflect.get(value, 'code');
  if (!isState(state) || typeof command !== 'string') return null;
  return typeof code === 'number' && Number.isInteger(code) ? { state, command, code } : { state, command };
}

/** The program is gone (or detached from): Ctrl+C now reaches xray, not the program. */
export function programDone(status: RunStatus): boolean {
  return status.state !== 'running';
}

/** xray itself needs this; the profiled program can be older. */
export const MIN_NODE_MAJOR = 22;

/** `node --version` output (`v22.3.0`) → 22; null when it is not one. */
export function nodeMajor(output: string): number | null {
  const match = /^v(\d+)\.\d+\.\d+/.exec(output.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
}
