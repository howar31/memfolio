// Builds the unpacked extension into dist/ (or dist-e2e/ with --e2e, which
// swaps the folder picker for the origin-private file system and shortens delays).
// With --firefox the build goes to dist-firefox/: a module `x.ts` is replaced by
// `x.firefox.ts` where that file exists, and a background script is added.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = process.argv.includes('--e2e');
const firefox = process.argv.includes('--firefox');
const out = join(root, firefox ? 'dist-firefox' : e2e ? 'dist-e2e' : 'dist');
const src = join(root, 'src');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const firefoxVariants = {
  name: 'firefox-variants',
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, (args) => {
      const variant = `${join(args.resolveDir, args.path)}.firefox.ts`;
      return existsSync(variant) ? { path: variant } : null;
    });
  },
};

await build({
  entryPoints: {
    content: join(src, 'platforms/instagram/content.ts'),
    bridge: join(src, 'platforms/instagram/bridge.main.ts'),
    popup: join(src, 'popup/popup.ts'),
    ...(firefox ? { background: join(src, 'background/saver.ts') } : {}),
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: firefox ? 'firefox128' : 'chrome111',
  plugins: firefox ? [firefoxVariants] : [],
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
if (firefox) {
  delete manifest.minimum_chrome_version;
  manifest.permissions.push('downloads');
  manifest.background = { scripts: ['background.js'] };
  manifest.browser_specific_settings = {
    gecko: { id: 'memfolio@howar31.com', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } },
  };
}
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

await cp(join(src, '_locales'), join(out, '_locales'), { recursive: true });
await cp(join(src, 'assets/icons'), join(out, 'icons'), { recursive: true });
await cp(join(src, 'popup/popup.html'), join(out, 'popup.html'));
await cp(join(src, 'popup/popup.css'), join(out, 'popup.css'));
await cp(join(src, 'platforms/instagram/content.css'), join(out, 'content.css'));

console.log(`built ${firefox ? 'firefox ' : e2e ? 'e2e ' : ''}extension ${manifest.version} in ${out}`);
