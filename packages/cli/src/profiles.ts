// A source's profiles as files DevTools and speedscope open, for `--profiles` and the dashboard.

import { toCpuProfile, toHeapProfile, withoutScript, type Timeline } from '@node-xray/core';

export type ProfileKind = 'cpu' | 'heap';

export interface ProfileFile {
  readonly fileName: string;
  readonly json: string;
}

/** The whole run's CPU profile or the latest allocation profile, without the agent's own frames; null when there is none. */
export function exportProfile(timeline: Timeline, kind: ProfileKind): ProfileFile | null {
  const hello = timeline.hello;
  if (hello === null) return null;
  const base = `xray-${hello.pid}-${hello.threadId}`;
  switch (kind) {
    case 'cpu': {
      const tree = timeline.cpuFlameTotal();
      return tree === null ? null : { fileName: `${base}.cpuprofile`, json: JSON.stringify(toCpuProfile(withoutScript(tree, hello.agentScript))) };
    }
    case 'heap': {
      const tree = timeline.allocations();
      return tree === null ? null : { fileName: `${base}.heapprofile`, json: JSON.stringify(toHeapProfile(withoutScript(tree, hello.agentScript))) };
    }
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}
