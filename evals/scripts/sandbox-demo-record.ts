import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquirePackagedSandboxLock } from "../worlds/packaged-sandbox-lock.ts";
import { profiles } from "../worlds/packaged-sandbox-fixtures.ts";
import { packagedDemoDesktop, runDesktopClip } from "../worlds/sandbox-demo-desktop.ts";
import { encode, exec, publishStills, requireDemo, sampledStill } from "../worlds/sandbox-demo-film.ts";

const demos = new Map([
  ["01", "01-first-enable"], ["02", "02-use-mode-chat"], ["03", "03-force-mode-chat"],
  ["04", "04-folders-both-sides"], ["05", "05-mid-chat-toggle"], ["06", "06-org-lock"],
]);
const [n = "", attempt = "web", expectedSha = "878d3b5ce1"] = process.argv.slice(2);
const expectedVersion = new Map([["75a9443cee", "0.18.70-sandbox.4"], ["878d3b5ce1", "0.18.70-sandbox.5"]]).get(expectedSha);
requireDemo(expectedVersion, "Unsupported demo build SHA");
const name = demos.get(n);
requireDemo(name, "Usage: sandbox-demo-record.ts 01|02|03|04|05|06 [web|desktop]");
const key = ["02", "03", "04", "05"].includes(n) ? process.env[profiles.fable.keyEnv]?.trim() : undefined;
const localMysql = process.env.OPENWORK_EVAL_MYSQL_URL;
for (const name of Object.keys(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|^OPENCODE_|^OPENWORK_|^DATABASE_/i.test(name)) delete process.env[name];
if (localMysql) process.env.OPENWORK_EVAL_MYSQL_URL = localMysql;
const cancel = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[]) process.on(signal, () => cancel.abort(new Error(`Recording interrupted: ${signal}`)));
const signal = AbortSignal.any([cancel.signal, AbortSignal.timeout(310_000)]);
const output = resolve(import.meta.dirname, "../../reports/sandbox-mode/demos");
let stage = "prerequisites";
try {
  const buildSha = (await readFile("/tmp/owafter/BUILD_SHA", "utf8")).trim();
  requireDemo(buildSha === expectedSha, `Expected BUILD_SHA=${expectedSha}; refusing to record any other build`);
  const { stdout: versionText } = await exec("/usr/libexec/PlistBuddy", ["-c", "Print CFBundleShortVersionString", "/tmp/owafter/OpenWork.app/Contents/Info.plist"], { timeout: 8000 });
  const version = versionText.trim();
  requireDemo(version === expectedVersion, "Unexpected packaged app version");
  requireDemo(n === "01" || n === "06" || key, "Missing Fable credential in Infisical dev environment");
  await mkdir(output, { recursive: true });
  const root = await realpath(await mkdtemp("/tmp/owrec-"));
  try {
    let directories: string[];
    let shots: string[];
    let outcome: string;
    stage = "machine lock";
    {
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(await acquirePackagedSandboxLock(`sandbox-demo/${n}`, signal));
      requireDemo((await readFile("/tmp/owafter/BUILD_SHA", "utf8")).trim() === buildSha, "Build changed while waiting for lock");
      stage = "packaged launch and take";
      if (n === "06") {
        const { orgDemo } = await import("../worlds/sandbox-demo-org.ts");
        ({ directories, shots, outcome } = await orgDemo(cleanup, root, signal, attempt, buildSha));
      } else {
        const desktop = await packagedDemoDesktop(cleanup, { root, signal, key, buildSha });
        const run = await runDesktopClip(n, desktop, root, signal);
        directories = [run.directory];
        ({ shots, outcome } = run);
        if (run.progress) {
          const still = join(root, "01-first-enable-progress.png");
          await sampledStill(run.directory, run.progress, still);
          shots.push(still);
        }
      }
    }
    stage = "encode and probe";
    signal.throwIfAborted();
    const { seconds, bytes, format } = await encode(directories, output, root, name);
    await publishStills(shots, output);
    const receipt = { name, buildSha, version, seconds, bytes, format, outcome, status: outcome.startsWith("Draft:") ? "draft: incomplete flow" : seconds >= 20 && seconds <= (n === "05" ? 90 : 60) ? "awaiting visual review" : "draft: duration outside requested range" };
    await writeFile(join(output, `${name}-receipt.json`), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify(receipt));
  } finally { await rm(root, { recursive: true, force: true }); }
} catch (error) {
  const message = error instanceof Error ? error.message.split("\n")[0] ?? "Unknown failure" : "Unknown failure";
  const safe = stage === "machine lock" && signal.aborted ? "Timed out waiting for the other E2E run to release /tmp/ow-e2e-lock" : /^(Expected|Unexpected|Missing|Timed out|Could not|No |Local Den|Recording interrupted|Renderer|Packaged|CDP|Both |Embedded|Transcript|Host file|Saved draft|Pending send|Retry |An owned|The app never|Could not locate)/.test(message) ? message : "Operation failed; detailed diagnostics suppressed to avoid exposing credentials";
  console.error(`${name} [${stage}]: ${key ? safe.replaceAll(key, "[redacted]") : safe}`);
  if (n === "01" && safe !== message) console.error(message.split(": ")[0]);
  process.exitCode = 1;
}
