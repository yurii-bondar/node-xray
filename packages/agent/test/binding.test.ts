import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentCommand } from '@node-xray/core';
import { bindingLink } from '../src/binding.js';
import { SelfWork } from '../src/self.js';

describe('bindingLink', () => {
  it('sends through the CDP binding and takes commands from the CLI', () => {
    const sent: string[] = [];
    Reflect.set(globalThis, '__test_binding', (payload: string) => sent.push(payload));
    const errors: unknown[] = [];
    const commands: AgentCommand[] = [];
    const link = bindingLink('__test_binding');
    const connection = link.link({ self: new SelfWork((e) => errors.push(e)), onCommand: (c) => commands.push(c), onClose: () => undefined });

    connection.send({ type: 'agent-error', message: 'hi' });
    assert.deepEqual(sent, ['{"type":"agent-error","message":"hi"}']);

    link.deliver('{"type":"loop-trace-stop"}');
    link.deliver('{"type":"rm"}');
    link.deliver('not json');
    assert.deepEqual(commands, [{ type: 'loop-trace-stop' }]);
    assert.equal(errors.length, 2, 'bad commands are reported, not thrown');

    // After detach the binding is gone: sending must not throw into the application.
    Reflect.deleteProperty(globalThis, '__test_binding');
    connection.send({ type: 'agent-error', message: 'nobody listens' });
  });
});
