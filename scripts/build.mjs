// Builds the unpacked extension into dist/ (or dist-e2e/ with --e2e, which
// swaps the folder picker for the origin-private file system and shortens delays).
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = process.argv.includes('--e2e');
const out = join(root, e2e ? 'dist-e2e' : 'dist');
const src = join(root, 'src');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: {
    content: join(src, 'platforms/instagram/content.ts'),
    bridge: join(src, 'platforms/instagram/bridge.main.ts'),
    popup: join(src, 'popup/popup.ts'),
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'chrome111',
  // Left readable on purpose: the shipped code is meant to be read.
  minify: false,
  legalComments: 'none',
  // Statements labelled `E2E:` are test scaffolding and are dropped from the production build.
  dropLabels: e2e ? [] : ['E2E'],
  logLevel: 'info',
});

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

await cp(join(src, '_locales'), join(out, '_locales'), { recursive: true });
await cp(join(src, 'assets/icons'), join(out, 'icons'), { recursive: true });
await cp(join(src, 'popup/popup.html'), join(out, 'popup.html'));
await cp(join(src, 'popup/popup.css'), join(out, 'popup.css'));
await cp(join(src, 'platforms/instagram/content.css'), join(out, 'content.css'));

console.log(`built ${e2e ? 'e2e ' : ''}extension ${manifest.version} in ${out}`);
