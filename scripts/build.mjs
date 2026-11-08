import { build } from 'esbuild';
import { mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { writeLicenseNotices } from './licenses.mjs';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/web', { recursive: true });
await Promise.all([
  build({
    entryPoints: ['src/index.ts', 'src/dev.ts', 'src/worker.ts'],
    outdir: 'dist',
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
  }),
  build({
    entryPoints: ['src/web/main.tsx'],
    outfile: 'dist/web/app.js',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file', '.svg': 'file' },
    assetNames: 'assets/[name]-[hash]',
    minify: true,
    legalComments: 'linked',
    metafile: true,
  }).then(async result => {
    await writeFile('dist/web/bundle-meta.json', JSON.stringify(result.metafile));
    await writeLicenseNotices(result.metafile);
  }),
]);
await copyFile('src/web/index.html', 'dist/web/index.html');
await copyFile('src/client.js', 'dist/client.js');
console.log('Built DSH plugin and local editor.');
