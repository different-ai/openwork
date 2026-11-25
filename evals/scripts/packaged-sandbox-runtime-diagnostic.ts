import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { isolatedParentEnvironment, isRecord } from "../worlds/packaged-sandbox-fixtures.ts";
import { acquirePackagedSandboxLock } from "../worlds/packaged-sandbox-lock.ts";

const exec = promisify(execFile);
const bundle = resolve(process.argv[2] ?? "/tmp/owafter/OpenWork.app");
if (!bundle.endsWith(".app") || bundle.startsWith("/Applications/")) throw new Error("Use an eval-owned packaged app");
const evidence = resolve(process.argv[3] ?? "reports/sandbox-mode/after/native-runtime-diagnostic.txt");
const resources = join(bundle, "Contents/Resources");
const root = await realpath(await mkdtemp("/tmp/owpdiag-"));
try {
  await mkdir(join(root, "home"));
  const unlock = await acquirePackagedSandboxLock("packaged sandbox native runtime diagnostic");
  try {
    const source = `
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
(async () => {
  const resources = process.argv[1];
  const requireFromAsar = createRequire(resources + '/app.asar/server/dist/embedded.js');
  const adapter = requireFromAsar.resolve('@openwork/sandbox-microsandbox');
  const entry = createRequire(adapter).resolve('microsandbox');
  const sdk = await import(pathToFileURL(entry).href);
  const image = JSON.parse(fs.readFileSync(resources + '/sandbox-image/manifest.json', 'utf8')).reference;
  const name = 'ow-eval-runtime-diagnostic';
  sdk.setDefaultBackend('local');
  console.log(JSON.stringify({ adapter, entry, image }));
  try {
    await sdk.Image.load(resources + '/sandbox-image/alpine.oci.tar', { tag: image });
    const task = await sdk.Sandbox.builder(name).image(image).disableNetwork().createWithProgress();
    await task.awaitSandbox();
    console.log('Native sandbox started');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    try { await (await sdk.Sandbox.get(name)).destroy({ force: true, timeoutMs: 10000 }); }
    catch (error) { if (error.code !== 'sandboxNotFound') console.error('cleanup', error); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });`;
    const result = await exec(join(bundle, "Contents/MacOS/OpenWork"), ["-e", source, resources], {
      cwd: root, env: { ...isolatedParentEnvironment(process.env), ELECTRON_RUN_AS_NODE: "1", HOME: join(root, "home"), MSB_HOME: join(root, "msb") }, timeout: 30_000,
    }).then(({ stdout, stderr }) => ({ stdout, stderr, status: 0 }), error => ({
      stdout: isRecord(error) ? error.stdout : "", stderr: isRecord(error) ? error.stderr : String(error), status: isRecord(error) ? error.code ?? error.signal : 1,
    }));
    await writeFile(evidence, `${JSON.stringify(result, null, 2)}\n`);
  } finally { await unlock(); }
} finally { await rm(root, { recursive: true, force: true }); }
