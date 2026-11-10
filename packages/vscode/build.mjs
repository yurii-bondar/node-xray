// The extension and everything it runs, as files inside the .vsix: the extension host bundle,
// the xray CLI as one ESM file, the agent bundles and the dashboard next to it.
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const agentDir = path.dirname(require.resolve('@node-xray/agent'));
const dashboardDir = path.join(path.dirname(require.resolve('@node-xray/dashboard/package.json')), 'dist');
const cliEntry = path.join(path.dirname(require.resolve('@node-xray/cli/package.json')), 'src', 'bin.ts');

await rm('dist/xray', { recursive: true, force: true });
await mkdir('dist/xray/dashboard', { recursive: true });
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], outfile: 'dist/extension.cjs', logLevel: 'warning' });
await build({ entryPoints: [cliEntry], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'dist/xray/cli.mjs', logLevel: 'warning' });
await cp(path.join(agentDir, 'agent.cjs'), 'dist/xray/agent.cjs');
await cp(path.join(agentDir, 'attach.cjs'), 'dist/xray/attach.cjs');
for (const file of ['index.html', 'app.js', 'app.css', 'uplot.css']) await cp(path.join(dashboardDir, file), path.join('dist/xray/dashboard', file));
