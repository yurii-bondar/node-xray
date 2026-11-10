// Running Node.js processes for the attach picker, from `ps -A -o pid=,args=`.

export interface NodeProcess {
  readonly pid: number;
  /** Full command line, for the picker. */
  readonly args: string;
}

/** Same rule as the CLI's: only a Node binary may get SIGUSR1. */
export function looksLikeNode(command: string): boolean {
  const name = command.trim().split(/[\\/]/).pop() ?? '';
  return /^(?:node|nodejs)(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(name);
}

/** `ps` lines are `<pid> <program> <args...>`; keeps the ones whose program is a Node binary. */
export function parseNodeProcesses(output: string, exclude: ReadonlySet<number>): NodeProcess[] {
  const out: NodeProcess[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)(.*)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const pid = Number(match[1]);
    if (exclude.has(pid) || !looksLikeNode(match[2])) continue;
    out.push({ pid, args: `${match[2]}${match[3] ?? ''}`.trim() });
  }
  return out;
}
