import { readFile, writeFile, mkdir, mkdtemp, readdir, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, relative, dirname } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = fileURLToPath(new URL('./', import.meta.url));
const requireApp = createRequire(resolve(root, 'apps/app/package.json'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let cached;
export function recoveryBuild() { return cached ??= buildFixture(); }
async function buildFixture() {
  // Resolve installed dependencies from THIS worktree; never from a prior proof.
  const { build } = await import(pathToFileURL(requireApp.resolve('vite')).href);
  const results = resolve(root, 'evals/results/crash-recovery');
  await mkdir(results, { recursive: true });
  const output = await mkdtemp(`${results}/source-`);
  const source = resolve(output, 'source');
  await mkdir(source);
  const ref = process.env.OPENWORK_RECOVERY_SOURCE_REF;
  if (ref) {
    const archive = execFileSync('git', ['archive', '--format=tar', ref, 'apps/app/src'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', source], { input: archive });
  } else {
    await cp(resolve(root, 'apps/app/src'), resolve(source, 'apps/app/src'), { recursive: true });
  }
  const sourceFiles = [];
  async function walk(dir, list, base) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(path, list, base);
      else list.push({ path: relative(base, path), sha256: digest(await readFile(path)) });
    }
  }
  await walk(resolve(source, 'apps/app/src'), sourceFiles, source);
  sourceFiles.sort((a, b) => a.path.localeCompare(b.path));
  const sourceHash = digest(JSON.stringify(sourceFiles));
  const version = `source-proof.${sourceHash.slice(0, 12)}`;
  const release = `source.${sourceHash}`;
  const manifest = { at: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), ref: ref ?? null, sourceHash, version, release, sourceFiles, variants: [], files: [] };
  const preload = await readFile(resolve(fixture, 'preload.js'), 'utf8');
  for (const [name, deployment, dsn] of [['web', 'web', 'https://fakepublickey@telemetry.invalid/123'], ['missing', 'web', ''], ['desktop', 'desktop', 'https://fakepublickey@telemetry.invalid/123']]) {
    const variant = { name, deployment, dsn, modules: [] };
    await build({
      root: fixture, configFile: false, envDir: false, envPrefix: 'CRASH_FIXTURE_NO_ENV_', publicDir: false, base: `/${name}/`, logLevel: 'warn',
      define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'import.meta.env.VITE_OPENWORK_APP_VERSION': JSON.stringify(version), 'import.meta.env.VITE_OPENWORK_BUILD_SHA': JSON.stringify(release), 'import.meta.env.VITE_OPENWORK_DEPLOYMENT': JSON.stringify(deployment), 'import.meta.env.VITE_OPENWORK_SENTRY_DSN': JSON.stringify(dsn), 'import.meta.env.VITE_OPENWORK_POSTHOG_KEY': JSON.stringify(''), 'import.meta.env.VITE_DEN_BASE_URL': JSON.stringify('https://den.invalid') },
      esbuild: { jsx: 'automatic', jsxDev: false },
      resolve: { alias: { '@': resolve(source, 'apps/app/src'), react: dirname(requireApp.resolve('react/package.json')), 'react-dom': dirname(requireApp.resolve('react-dom/package.json')) } },
      plugins: [{ name: 'source-fixture-provenance', transformIndexHtml: { order: 'pre', handler: () => [{ tag: 'script', children: preload, injectTo: 'head-prepend' }] }, async generateBundle() { for (const id of this.getModuleIds()) if (id.startsWith(source) && !id.includes('?')) variant.modules.push({ path: relative(source, id), sha256: digest(await readFile(id)) }); } }],
      build: { outDir: resolve(output, `site/${name}`), emptyOutDir: true, minify: false, sourcemap: false, reportCompressedSize: false },
    });
    manifest.variants.push(variant);
  }
  await walk(resolve(output, 'site'), manifest.files, output);
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const assets = new Map();
  for (const file of manifest.files) assets.set('/' + file.path.slice('site/'.length), { body: (await readFile(resolve(output, file.path))).toString('base64'), contentType: file.path.endsWith('.html') ? 'text/html' : 'text/javascript' });
  return { output, version, release, manifest, assets };
}
