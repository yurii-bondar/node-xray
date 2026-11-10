import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CpuProfile } from '../src/cdp.js';
import { LineTicks } from '../src/lines.js';
import { Timeline } from '../src/timeline.js';
import { callFrame, hello } from './fixtures.js';

const agent = '/opt/xray/agent.cjs';

const profile: CpuProfile = {
  startTime: 0,
  endTime: 1,
  samples: [],
  nodes: [
    { id: 1, callFrame: callFrame('(root)'), hitCount: 0, children: [2, 3, 4, 5], positionTicks: [] },
    { id: 2, callFrame: callFrame('(idle)'), hitCount: 50, children: [], positionTicks: [] },
    { id: 3, callFrame: callFrame('render', 9), hitCount: 8, children: [], positionTicks: [{ line: 11, ticks: 6 }, { line: 12, ticks: 2 }] },
    { id: 4, callFrame: callFrame('tick', 3, 'file:///opt/xray/agent.cjs'), hitCount: 5, children: [], positionTicks: [{ line: 4, ticks: 5 }] },
    { id: 5, callFrame: { ...callFrame('(garbage collector)'), url: '' }, hitCount: 2, children: [], positionTicks: [] },
  ],
};

describe('LineTicks', () => {
  it('adds samples per line across windows, leaving idle and the agent out', () => {
    const lines = new LineTicks();
    lines.add(profile, agent);
    lines.add(profile, agent);
    const { work, files } = lines.snapshot();
    assert.equal(work, 20, 'render 8 + GC 2, twice');
    assert.deepEqual([...files.keys()], ['file:///app/server.js']);
    assert.deepEqual([...(files.get('file:///app/server.js') ?? new Map())], [
      [11, 12],
      [12, 4],
    ]);
  });

  it('is fed by the timeline from CPU windows', () => {
    const timeline = new Timeline();
    timeline.apply({ ...hello, agentScript: agent });
    timeline.apply({ type: 'cpu-profile', start: 0, end: 1, profile });
    assert.equal(timeline.hotLines().work, 10);
  });
});
