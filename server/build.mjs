import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'build/public');
await mkdir(resolve(root, 'build'), { recursive: true });
await rm(output, { recursive: true, force: true });
await cp(resolve(root, 'web'), output, { recursive: true, dereference: false });
await cp(resolve(root, 'media'), resolve(output, 'media'), { recursive: true, dereference: false });
await build({ absWorkingDir: root, entryPoints: ['web/world.mjs'], bundle: true, format: 'esm', platform: 'browser',
  target: 'es2022', outfile: resolve(output, 'world.mjs'), legalComments: 'inline', minify: false, sourcemap: false });
let index = await readFile(resolve(output, 'index.html'), 'utf8');
const fingerprints = {};
for (const name of ['world.mjs', 'world.css', 'world-gestures.css']) {
  const digest = createHash('sha256').update(await readFile(resolve(output, name))).digest('hex').slice(0, 12);
  fingerprints[name] = digest;
  index = index.replace(new RegExp(`/${name.replace('.', '\\.')}\\"`, 'g'), `/${name}?v=${digest}"`);
}
await writeFile(resolve(output, 'index.html'), index);
console.log(JSON.stringify({ built: true, output: 'build/public', runtimeDependencies: 0, fingerprints }));
