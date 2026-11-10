// Bundles the dashboard for the browser into dist/: app.js, app.css, uplot.css, index.html.
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  outfile: 'dist/app.js',
  logLevel: 'warning',
});
await copyFile('static/index.html', 'dist/index.html');
await copyFile('static/app.css', 'dist/app.css');
await copyFile(require.resolve('uplot/dist/uPlot.min.css'), 'dist/uplot.css');
