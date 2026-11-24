import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LineDecoder } from '@node-xray/core';
import { socketLink, writeAllSync } from '../src/connection.js';
import { errorMessage, SelfWork } from '../src/self.js';

let dir = '';
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'xray-conn-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/** A CLI that accepts the connection and does not read until told to. */
async function stalledCli(): Promise<{ path: string; peer: Promise<net.Socket>; close: () => Promise<void> }> {
  const socketPath = path.join(dir, `s${Math.random().toString(36).slice(2, 8)}.sock`);
  let accept: (socket: net.Socket) => void = () => undefined;
  const peer = new Promise<net.Socket>((resolve) => (accept = resolve));
  const server = net.createServer((socket) => {
    socket.pause();
    accept(socket);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    path: socketPath,
    peer,
    close: async () => {
      (await peer).destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('socket connection', () => {
  it('reports messages dropped while the CLI was not reading, once it reads again', async () => {
    const cli = await stalledCli();
    const sent: string[] = [];
    const self: SelfWork = new SelfWork((error) => connection.send({ type: 'agent-error', message: errorMessage(error) }));
    const connection = socketLink(cli.path)({ self, onCommand: () => undefined, onClose: () => undefined });
    const peer = await cli.peer;
    const big = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 24; i++) connection.send({ type: 'agent-error', message: big });

    const decoder = new LineDecoder(4 * 1024 * 1024);
    peer.setEncoding('utf8');
    peer.on('data', (chunk: string) => {
      for (const line of decoder.push(chunk)) sent.push(line.length > 200 ? 'big' : line);
    });
    peer.resume();
    // Until the queue drained: no new lines for a while.
    for (let seen = -1; seen !== sent.length; ) {
      seen = sent.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    connection.send({ type: 'agent-error', message: 'after' });
    while (!sent.some((line) => line.includes('after'))) await new Promise((resolve) => setTimeout(resolve, 10));

    const through = sent.filter((line) => line === 'big').length;
    assert.ok(through < 24, `${through} big lines went through`);
    const report = sent.findIndex((line) => line.includes('dropped'));
    assert.ok(sent[report]?.includes(`${24 - through} message(s) dropped`), sent[report]);
    assert.ok(report < sent.findIndex((line) => line.includes('after')), 'reported ahead of the next message');
    connection.close();
    await cli.close();
  });
});

describe('writeAllSync', () => {
  it('gives up at the deadline, and at once when it already passed', async () => {
    const cli = await stalledCli();
    const client = net.createConnection(cli.path);
    await new Promise<void>((resolve) => client.on('connect', () => resolve()));
    const fd: unknown = Reflect.get(Reflect.get(client, '_handle') as object, 'fd');
    assert.equal(typeof fd, 'number');
    const data = Buffer.alloc(32 * 1024 * 1024);
    const started = Date.now();
    assert.equal(writeAllSync(fd as number, data, started + 100), false);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `${elapsed} ms`);
    const again = Date.now();
    assert.equal(writeAllSync(fd as number, data, started + 100), false);
    assert.ok(Date.now() - again < 20);
    client.destroy();
    await cli.close();
  });
});
