import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { SourceMapResolver } from '../src/sourcemaps.js';

// Generated line 2, column 5 → src/app.ts 2:5 `parse`; column 14 → src/util.ts 10:3.
const MAP = { version: 3, sourceRoot: '../src', sources: ['app.ts', 'util.ts'], names: ['parse'], mappings: 'AAAA;AACA,IAAIA,SCQF' };

describe('SourceMapResolver', () => {
  let dir = '';
  let reads: string[] = [];
  let resolver: SourceMapResolver;

  before(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'xray-maps-'));
    mkdirSync(path.join(dir, 'dist'));
    writeFileSync(path.join(dir, 'dist', 'app.js'), 'a();\nb(); c();\n//# sourceMappingURL=app.js.map\n');
    writeFileSync(path.join(dir, 'dist', 'app.js.map'), JSON.stringify(MAP));
    const inline = Buffer.from(JSON.stringify(MAP)).toString('base64');
    writeFileSync(path.join(dir, 'dist', 'inline.js'), `a();\nb();\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${inline}\n`);
    writeFileSync(path.join(dir, 'dist', 'plain.js'), 'a();\n');
    resolver = new SourceMapResolver((file) => {
      reads.push(path.basename(file));
      return readFile(file, 'utf8');
    });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('maps a profile frame (file URL, 1-based) to the original TypeScript', async () => {
    const url = pathToFileURL(path.join(dir, 'dist', 'app.js')).href;
    assert.deepEqual(await resolver.resolve({ url, line: 2, column: 6 }), { file: path.join(dir, 'src', 'app.ts'), line: 2, column: 5, name: 'parse' });
    assert.deepEqual(await resolver.resolve({ url, line: 2, column: 20 }), { file: path.join(dir, 'src', 'util.ts'), line: 10, column: 3, name: null });
  });

  it('loads each map once and reads inline maps', async () => {
    reads = [];
    const file = path.join(dir, 'dist', 'inline.js');
    const results = await resolver.resolveAll([
      { url: file, line: 2, column: 6 },
      { url: file, line: 1, column: 1 },
    ]);
    assert.equal(results.size, 2);
    assert.deepEqual(reads, ['inline.js']);
  });

  it('leaves alone what it cannot map', async () => {
    assert.equal(await resolver.resolve({ url: path.join(dir, 'dist', 'plain.js'), line: 1, column: 1 }), null);
    assert.equal(await resolver.resolve({ url: path.join(dir, 'dist', 'missing.js'), line: 1, column: 1 }), null);
    assert.equal(await resolver.resolve({ url: 'node:internal/timers', line: 5, column: 1 }), null);
    assert.equal(await resolver.resolve({ url: path.join(dir, 'dist', 'app.js.map'), line: 1, column: 1 }), null, 'only scripts');
    assert.equal(await resolver.resolve({ url: '', line: 0, column: 0 }), null);
  });
});
