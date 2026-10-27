/**
 * Fast path for "1 Den + N desktops in minutes": build ONE clean, identity-free
 * desktop, save it as a Daytona snapshot, clone attendees from it against an
 * existing workshop pair's Den, and time every stage.
 *
 *   node worlds/workshop-clone.ts --pair-dir <pair run dir> --output-dir <private dir> --phase base|clones|signin|cleanup|all
 *     [--count 19] [--concurrency 5] [--ttl 120] [--suffix <a-z0-9>] [--snapshot <existing workshop-desktop-* name>]
 *
 * The pair (worlds/workshop-pair.ts) is only read: its control.json supplies the
 * Den URLs, org, workshop model and one member login. Nothing here stops it.
 * report.json in the output dir is the resumable state and the timing table.
 * `all` = base + clones + signin; `cleanup` (run explicitly) deletes every
 * recorded clone and the base, and keeps the snapshot, which holds no identity.
 */
import { assertTrustedWorkshopRef, assertVerifiedWorkshopSnapshot } from "./lib/workshop-trust.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { attachSurface, browserScript, probeAppStateOnSurface } from "../evals/packages/cdp/src/index.ts";
import type { Surface } from "../evals/packages/cdp/src/index.ts";
import { control, evalIn, parseSessionToolCalls, waitFor, waitUntilInteractive } from "../evals/packages/behaviors/src/desktop.ts";
import { createAndSelectWorkspace, signInDesktopAs } from "../evals/packages/behaviors/src/desktop-boot.ts";
import { sendComposerMessage, waitForAssistantReply } from "../evals/packages/behaviors/src/composer.ts";
import { denFetch } from "../evals/packages/behaviors/src/den.ts";
import type { DenRef, DenSession } from "../evals/packages/behaviors/src/den.ts";
import { desktop } from "../evals/packages/hosts/src/desktop.ts";
import { createDaytonaHost, defaultDaytonaExec } from "../evals/packages/hosts/src/daytona.ts";
import { deleteSandboxes, execInSandbox, provisionDesktopSandbox } from "../evals/packages/hosts/src/provision.ts";
import { parsePrivatePreview, privateSandboxId } from "../evals/packages/hosts/src/private-web-preview.ts";
import { installWorkshopBrowser, WORKSHOP_BROWSER_LAUNCHER, workshopRemoteScript } from "./lib/workshop-browser.ts";
import { linkWorkshopRuntime, selectWorkshopModel } from "./lib/workshop-models.ts";
import { redactWorkshopDiagnostic } from "./lib/workshop-redaction.ts";
import {
  cleanBaseAuditScript, DaytonaApi, pagedSnapshotListExec, parseCleanBaseAudit, parseProvisionSteps, percentile,
  saveSandboxSnapshot, settledPool, stopWorkshopAppsScript, WORKSHOP_SNAPSHOT_PREFIX, workshopSnapshotName,
} from "./lib/workshop-snapshot.ts";
import { unlockWorkshopDesktop } from "./lib/workshop-unlock.ts";
import { verifySandbox } from "./workshop-fleet.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKSPACE = "/home/daytona/workshop/workspace";
const PHASES = ["base", "clones", "signin", "cleanup", "all"] as const;
const APP_ENV = { VITE_DISABLE_OPENWORK_MODELS: "0", OPENWORK_ENGINE_V2_PREVIEW: "1", OPENWORK_AUTOMATION_RUNNER: "on", BROWSER: WORKSHOP_BROWSER_LAUNCHER };
const TASK_PROMPT = "Read-only check. Using the connected workshop Outlook tool only (at most 2 tool calls, no shell, change nothing), find the latest Northwind pilot email and reply in under 50 words with its exact subject and whether the pilot is production-ready.";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function field(value: unknown, key: string): string {
  assert.ok(record(value) && typeof value[key] === "string" && value[key], `pair control.json is missing ${key}`);
  return String(value[key]);
}
const seconds = (from: number) => Math.round((Date.now() - from) / 100) / 10;

export function parseCloneOptions(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!flag?.startsWith("--") || value === undefined || values.has(flag)) throw new Error("Flags take one value each, without duplicates.");
    values.set(flag, value);
  }
  const known = new Set(["--pair-dir", "--output-dir", "--phase", "--count", "--concurrency", "--ttl", "--suffix", "--snapshot"]);
  for (const flag of values.keys()) if (!known.has(flag)) throw new Error(`Unknown flag ${flag}.`);
  const pairDir = values.get("--pair-dir"), outputDir = values.get("--output-dir");
  if (!pairDir || !isAbsolute(pairDir) || !outputDir || !isAbsolute(outputDir)) throw new Error("--pair-dir and --output-dir must be absolute paths.");
  const rel = relative(REPO_ROOT, resolve(outputDir));
  if (rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("Output directory must be outside this checkout.");
  const phase = PHASES.find((entry) => entry === (values.get("--phase") ?? "all"));
  if (!phase) throw new Error(`--phase must be one of ${PHASES.join(", ")}.`);
  const int = (flag: string, fallback: number, min: number, max: number) => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${flag} must be ${min}..${max}.`);
    return Number(raw);
  };
  const snapshot = values.get("--snapshot");
  if (snapshot !== undefined && !snapshot.startsWith(WORKSHOP_SNAPSHOT_PREFIX)) throw new Error(`--snapshot must be a ${WORKSHOP_SNAPSHOT_PREFIX}* name.`);
  return {
    pairDir: resolve(pairDir), outputDir: resolve(outputDir), phase,
    count: int("--count", 19, 1, 25), concurrency: int("--concurrency", 5, 1, 10), ttlMinutes: int("--ttl", 120, 30, 240),
    suffix: values.get("--suffix") ?? "", snapshot,
  };
}

interface CloneEntry {
  index: number; name?: string; sandboxId?: string; ok?: boolean; error?: string;
  private?: boolean; organizationId?: string; cpu?: number; memoryGiB?: number;
  createStartedAt?: string; provisionSeconds?: number; provisionSteps?: Record<string, number>;
  dependenciesInstalled?: boolean; appStartSeconds?: number; appRoute?: string; appState?: string; cdpPort?: string;
  createToInteractiveSeconds?: number; denReach?: Record<string, unknown>; screenshot?: string; deleted?: boolean;
}
interface Report {
  version: 1; runId: string; ref: string; pairRunId: string; denSandbox: string; orgId: string; modelId: string;
  startedAt: string; updatedAt?: string;
  base?: { sandboxId?: string; name?: string; provisionSeconds?: number; provisionSteps?: Record<string, number>; browserAndUnlockSeconds?: number;
    stopAppsSeconds?: number; audit?: { ok: boolean; findings: string[] }; dependenciesInstalled?: boolean; deleted?: boolean; error?: string };
  snapshot?: { name: string; id?: string; state?: string; stopSeconds?: number; snapshotSeconds?: number; buildTotalSeconds?: number; kept?: boolean };
  clones: CloneEntry[];
  /** One entry per clones run; the first is the main fan-out. */
  fanouts?: Fanout[];
  externalDeletion?: Record<string, unknown>;
  signInHistory?: Record<string, unknown>[];
  /** Legacy single fan-out field; migrated into fanouts on load. */
  fanout?: Fanout;
  signIn?: Record<string, unknown>;
  cleanup?: { deleted: string[]; failed: string[]; at: string };
  gaps?: string[];
}
interface Fanout { count: number; concurrency: number; startedAt?: string; wallSeconds?: number; passed?: number; failed?: number;
  createToInteractive?: { p50: number | null; p95: number | null; max: number | null }; provision?: { p50: number | null; p95: number | null; max: number | null } }

async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700, recursive: true });
  await chmod(path, 0o700);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("Output directory must be a caller-owned directory.");
}
async function privateFile(path: string, content: string | Buffer) {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}
async function screenshot(surface: Surface, path: string): Promise<string | undefined> {
  const image: unknown = await surface.client.send("Page.captureScreenshot", { format: "png" });
  if (!record(image) || typeof image.data !== "string") return undefined;
  await privateFile(path, Buffer.from(image.data, "base64"));
  return path;
}

async function readPair(pairDir: string) {
  const pair: unknown = JSON.parse(await readFile(join(pairDir, "control.json"), "utf8"));
  assert.ok(record(pair) && record(pair.memberLogin), "pair control.json lacks a member login");
  const login = pair.memberLogin;
  const member: DenSession = { email: field(login, "email"), password: field(login, "password"), token: field(login, "token"), apiUrl: field(login, "apiUrl"), webUrl: field(login, "webUrl") };
  const den: DenRef = { apiUrl: field(pair, "denApiUrl"), webUrl: field(pair, "denWebUrl") };
  return { runId: field(pair, "runId"), ref: field(pair, "ref"), denSandbox: field(pair, "denSandbox"), desktopSandbox: field(pair, "desktopSandbox"),
    orgId: field(pair, "orgId"), memberId: field(pair, "memberId"), modelId: field(pair, "modelId"), expiresAt: field(pair, "expiresAt"), member, den };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCloneOptions(argv);
  const pair = await readPair(options.pairDir);
  assert.match(pair.ref, /^[0-9a-f]{40}$/, "pair ref must be a full SHA");
  await assertTrustedWorkshopRef(pair.ref, REPO_ROOT);
  await privateDirectory(options.outputDir);
  const reportPath = join(options.outputDir, "report.json");
  const existing: unknown = await readFile(reportPath, "utf8").then((text) => JSON.parse(text), () => null);
  const report: Report = {
    version: 1, runId: randomBytes(4).toString("hex"), ref: pair.ref, pairRunId: pair.runId, denSandbox: pair.denSandbox,
    orgId: pair.orgId, modelId: pair.modelId, startedAt: new Date().toISOString(), clones: [],
  };
  // Resume our own earlier state file.
  if (record(existing) && existing.version === 1 && existing.ref === pair.ref && Array.isArray(existing.clones)) Object.assign(report, existing);
  if (report.fanout) { report.fanouts = [report.fanout, ...(report.fanouts ?? [])]; delete report.fanout; }
  const privateValues = [pair.member.password, pair.member.token, pair.den.apiUrl, pair.den.webUrl, pair.member.apiUrl, pair.member.webUrl];
  const redact = (error: unknown) => redactWorkshopDiagnostic(error instanceof Error ? error.message : String(error), privateValues).slice(0, 3000);
  const save = async () => { report.updatedAt = new Date().toISOString(); await privateFile(reportPath, `${JSON.stringify(report, null, 2)}\n`); };
  const log = (line: string) => console.log(`workshop-clone: ${redactWorkshopDiagnostic(line, privateValues)}`);
  const api = new DaytonaApi();
  const exec = pagedSnapshotListExec(defaultDaytonaExec);
  await save();

  // Never touch the pair's own sandboxes.
  const protectedIds = new Set([pair.denSandbox, pair.desktopSandbox]);
  const assertOwned = (id: string) => { if (protectedIds.has(id)) throw new Error("Refusing to act on the pair's sandbox."); };

  async function remote(id: string, script: string, context: string, timeoutMs = 120_000) {
    return execInSandbox(defaultDaytonaExec, id, workshopRemoteScript(script), { timeoutMs, context });
  }

  async function phaseBase() {
    if (options.snapshot) { report.snapshot = { name: options.snapshot, kept: true }; await save(); return; }
    if (report.snapshot?.state === "active") { log(`snapshot ${report.snapshot.name} already active; skipping base`); return; }
    const name = report.snapshot?.name && !report.snapshot.state ? report.snapshot.name : workshopSnapshotName(pair.ref, new Date(), options.suffix);
    let baseId = report.base?.sandboxId && report.base.provisionSeconds !== undefined && !report.base.deleted ? report.base.sandboxId : "";
    let t = Date.now();
    if (baseId) {
      // Resume our own provisioned base (for example after an audit fix); never a foreign sandbox.
      assertOwned(baseId);
      await verifySandbox(baseId);
      log(`resuming base ${baseId}`);
    } else {
      report.base = { name: `workshop-clone-base-${report.runId}` };
      report.snapshot = { name };
      await save();
      const steps: string[] = [];
      log("provisioning clean base desktop (repo, deps, build, first boot)…");
      const provisioned = await provisionDesktopSandbox({
        ref: pair.ref, name: report.base.name ?? "workshop-clone-base", private: true, secrets: false,
        ttlMinutes: options.ttlMinutes, autoStopMinutes: 0, exec, log: (line) => steps.push(line),
        onCreated: async (sandbox) => { report.base = { ...report.base, sandboxId: sandbox }; await save(); },
      });
      assert.ok(provisioned.created, "base must be a newly created sandbox");
      baseId = await privateSandboxId(provisioned.sandbox);
      assertOwned(baseId);
      await verifySandbox(baseId);
      Object.assign(report.base, { sandboxId: baseId, provisionSeconds: seconds(t), provisionSteps: parseProvisionSteps(steps),
        dependenciesInstalled: provisioned.source?.dependenciesInstalled });
      await save();
      log(`base ${baseId} provisioned in ${report.base.provisionSeconds}s`);
      t = Date.now();
      await installWorkshopBrowser(baseId);
      await unlockWorkshopDesktop(baseId);
      report.base.browserAndUnlockSeconds = seconds(t);
    }
    const base = report.base;
    assert.ok(base);
    t = Date.now();
    const stopped = await remote(baseId, stopWorkshopAppsScript(), "stop app processes on base");
    assert.ok(stopped.stdout.includes("STOPPED"), "base app stop script did not finish");
    base.stopAppsSeconds = seconds(t);
    const audit = parseCleanBaseAudit((await remote(baseId, cleanBaseAuditScript(), "clean base audit", 180_000)).stdout);
    base.audit = audit;
    await save();
    if (!audit.ok) throw new Error(`Clean base audit failed: ${audit.findings.join("; ").slice(0, 2000)}`);
    log("base audit clean; stopping and snapshotting…");
    const saved = await saveSandboxSnapshot(api, baseId, name, log);
    // Build time = sum of real stage durations, so a resumed audit does not count idle time.
    const buildTotalSeconds = Math.round(((base.provisionSeconds ?? 0) + (base.browserAndUnlockSeconds ?? 0) + (base.stopAppsSeconds ?? 0) + saved.stopSeconds + saved.snapshotSeconds) * 10) / 10;
    report.snapshot = { ...saved, buildTotalSeconds, kept: true };
    await save();
    log(`snapshot ${name} active (${saved.snapshotSeconds}s); base build total ${report.snapshot.buildTotalSeconds}s`);
  }

  async function denReach(id: string, surface: Surface) {
    const apiB64 = Buffer.from(pair.den.apiUrl).toString("base64"), webB64 = Buffer.from(pair.den.webUrl).toString("base64");
    const vm = await remote(id, `set -u
api=$(printf %s ${apiB64} | base64 -d)
web=$(printf %s ${webB64} | base64 -d)
printf "API_HEALTH=%s\\n" "$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$api/health")"
printf "WEB=%s\\n" "$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$web/")"
`, "Den reachability from inside the VM", 60_000);
    const apiHealth = /API_HEALTH=(\d+)/.exec(vm.stdout)?.[1] ?? "none";
    const web = /WEB=(\d+)/.exec(vm.stdout)?.[1] ?? "none";
    const renderer = await evalIn(surface, browserScript(async (apiUrl, webUrl) => {
      const result: Record<string, unknown> = {};
      try { const response = await fetch(`${apiUrl}/health`, { cache: "no-store" }); result.corsHealth = response.status; }
      catch (error) { result.corsHealth = error instanceof Error ? error.name : "error"; }
      try { await fetch(`${webUrl}/`, { mode: "no-cors", cache: "no-store" }); result.webReachable = true; }
      catch { result.webReachable = false; }
      result.bootstrapWebMatches = localStorage.getItem("openwork.den.baseUrl") === webUrl;
      result.bootstrapApiMatches = localStorage.getItem("openwork.den.apiBaseUrl") === apiUrl;
      return result;
    }, [pair.den.apiUrl, pair.den.webUrl]), { timeoutMs: 45_000 });
    const seen: Record<string, unknown> = record(renderer) ? renderer : {};
    const facts = { vmApiHealth: apiHealth, vmWeb: web, ...seen };
    const ok = apiHealth === "200" && /^(2|3)\d\d$/.test(web) && (seen.corsHealth === 200 || seen.webReachable === true);
    return { ok, ...facts };
  }

  async function bootClone(entry: CloneEntry): Promise<void> {
    const snapshot = report.snapshot?.name;
    assert.ok(snapshot, "no snapshot recorded; run --phase base first");
    const steps: string[] = [];
    const createStarted = Date.now();
    entry.createStartedAt = new Date(createStarted).toISOString();
    entry.name = `workshop-clone-${report.runId}-${String(entry.index).padStart(2, "0")}`;
    const provisioned = await provisionDesktopSandbox({
      ref: pair.ref, name: entry.name, snapshot, private: true, secrets: false, ttlMinutes: options.ttlMinutes, autoStopMinutes: 0,
      exec, log: (line) => steps.push(line),
      onCreated: async (sandbox) => { entry.sandboxId = sandbox; await save(); },
    });
    const id = await privateSandboxId(provisioned.sandbox);
    assertOwned(id);
    entry.sandboxId = id;
    entry.provisionSeconds = seconds(createStarted);
    entry.provisionSteps = parseProvisionSteps(steps);
    entry.dependenciesInstalled = provisioned.source?.dependenciesInstalled;
    const info = await verifySandbox(id);
    Object.assign(entry, { private: info.public === false, organizationId: info.organizationId, cpu: info.cpu, memoryGiB: info.memoryGiB });
    await save();
    // Snapshot carried the workshop browser + workspace; only the X session settings are per boot.
    await unlockWorkshopDesktop(id);
    const appStarted = Date.now();
    const host = createDaytonaHost({ sandboxId: id, repoRoot: REPO_ROOT, previewExpirySeconds: 3 * 3600, log: () => {} });
    const surface = await desktop({
      name: `clone-${entry.index}`, host, timeoutMs: 300_000,
      bootstrap: { baseUrl: pair.den.webUrl, apiBaseUrl: pair.den.apiUrl, requireSignin: false, enterpriseActivation: { activatedAt: new Date().toISOString(), denBaseUrl: pair.den.apiUrl } },
      env: APP_ENV,
    });
    entry.appStartSeconds = seconds(appStarted);
    entry.createToInteractiveSeconds = seconds(createStarted);
    entry.appRoute = surface.readiness.route;
    entry.appState = String(surface.readiness.state);
    entry.cdpPort = surface.handle.meta?.cdpPort;
    await save();
    const reach = await denReach(id, surface);
    entry.denReach = reach;
    entry.screenshot = await screenshot(surface, join(options.outputDir, `clone-${String(entry.index).padStart(2, "0")}.png`)).catch(() => undefined);
    // Leave Electron running for the sign-in phase; only drop the CDP socket.
    surface.client.close();
    if (!reach.ok) throw new Error("Desktop booted but could not reach the Den.");
    entry.ok = true;
  }

  async function phaseClones() {
    assert.ok(report.snapshot?.name, "no snapshot recorded; run --phase base first");
    // Clones are only made from a snapshot whose provenance has been reviewed.
    await assertVerifiedWorkshopSnapshot(report.snapshot.name, pair.ref, REPO_ROOT);
    if (!report.snapshot.state) {
      const found = await api.getSnapshot(report.snapshot.name);
      assert.ok(found?.state === "active", `snapshot ${report.snapshot.name} is not active`);
      Object.assign(report.snapshot, { id: found.id, state: found.state });
    }
    const start = report.clones.length;
    const entries: CloneEntry[] = Array.from({ length: options.count }, (_, i) => ({ index: start + i + 1 }));
    report.clones.push(...entries);
    const fanout: Fanout = { count: options.count, concurrency: options.concurrency, startedAt: new Date().toISOString() };
    report.fanouts = [...(report.fanouts ?? []), fanout];
    await save();
    const fanStarted = Date.now();
    const results = await settledPool(entries, options.concurrency, async (entry) => {
      log(`clone ${entry.index}: creating…`);
      try { await bootClone(entry); log(`clone ${entry.index}: interactive in ${entry.createToInteractiveSeconds}s (provision ${entry.provisionSeconds}s)`); }
      catch (error) { entry.ok = false; entry.error = redact(error); log(`clone ${entry.index}: FAILED ${entry.error.slice(0, 300)}`); throw error; }
      finally { await save(); }
    });
    const passed = entries.filter((entry) => entry.ok);
    const ready = passed.map((entry) => entry.createToInteractiveSeconds ?? 0);
    const provision = entries.flatMap((entry) => entry.provisionSeconds === undefined ? [] : [entry.provisionSeconds]);
    Object.assign(fanout, { wallSeconds: seconds(fanStarted), passed: passed.length,
      failed: results.filter((result) => result.status === "rejected").length,
      createToInteractive: { p50: percentile(ready, 50), p95: percentile(ready, 95), max: percentile(ready, 100) },
      provision: { p50: percentile(provision, 50), p95: percentile(provision, 95), max: percentile(provision, 100) } });
    await save();
    log(`fan-out: ${passed.length}/${options.count} interactive in ${fanout.wallSeconds}s wall`);
  }

  async function memberUsage(): Promise<number | null> {
    const result = await denFetch(pair.member, "/v1/gateway/usage-limits/me", { headers: { authorization: `Bearer ${pair.member.token}`, "x-openwork-org-id": pair.orgId } });
    const bucket = record(result.body) && Array.isArray(result.body.buckets) ? result.body.buckets.find(record) : undefined;
    return record(bucket) && typeof bucket.usedMicroUsd === "number" ? bucket.usedMicroUsd : null;
  }

  async function phaseSignIn() {
    // Newest interactive clone that still exists (someone else may have deleted older ones).
    let target: CloneEntry | undefined;
    for (const entry of [...report.clones].reverse()) {
      if (!entry.ok || !entry.sandboxId || !entry.cdpPort || entry.deleted) continue;
      const live = await api.getSandbox(entry.sandboxId);
      if (live?.state === "started") { target = entry; break; }
      entry.deleted = true;
    }
    assert.ok(target?.sandboxId && target.cdpPort, "no interactive clone to sign in on");
    if (report.signIn) report.signInHistory = [...(report.signInHistory ?? []), report.signIn];
    const id = target.sandboxId;
    assertOwned(id);
    const result: Record<string, unknown> = { cloneIndex: target.index, sandboxId: id, startedAt: new Date().toISOString() };
    report.signIn = result;
    await save();
    const signed = await defaultDaytonaExec(["preview-url", id, "-p", target.cdpPort, "--expires", "7200"], { timeoutMs: 30_000 });
    assert.equal(signed.code, 0, "could not mint the clone's private CDP endpoint");
    const cdpUrl = parsePrivatePreview(signed.stdout, id, Number(target.cdpPort)).browserOrigin;
    await using surface = await attachSurface({ name: `clone-${target.index}-signin`, hostKind: "daytona", sandboxId: id, kind: "electron", cdpUrl });
    try {
      let t = Date.now();
      await createAndSelectWorkspace(surface, { path: WORKSPACE });
      await signInDesktopAs(surface, pair.den, pair.member);
      const { workspaceId } = await createAndSelectWorkspace(surface, { path: WORKSPACE });
      const auth = await control(surface, "auth.status");
      result.signedInAsMember = record(auth) && record(auth.user) && auth.user.email === pair.member.email;
      result.signInSeconds = seconds(t);
      await screenshot(surface, join(options.outputDir, "signin-signed-in.png")).catch(() => undefined);
      await save();
      assert.ok(result.signedInAsMember, "desktop is not signed in as the pair member");

      t = Date.now();
      const openTask = async () => {
        await control(surface, "session.create_task");
        await waitFor(surface, () => /\/session\/[^/?#]+/.test(window.location.hash || window.location.pathname), { timeoutMs: 60_000, label: "task session route" });
      };
      await openTask();
      result.modelVisibleWithoutRuntimeLink = await selectWorkshopModel(surface, pair.modelId).then(() => true, () => false);
      if (!result.modelVisibleWithoutRuntimeLink) {
        await linkWorkshopRuntime(surface, pair.member, pair.orgId, workspaceId);
        await surface.client.send("Page.reload", { ignoreCache: true });
        await waitUntilInteractive(surface, { timeoutMs: 120_000 });
        await openTask();
        await selectWorkshopModel(surface, pair.modelId);
      }
      const app = await probeAppStateOnSurface(surface);
      const models = await control(surface, "models.list", { workspaceId: app.workspaceId });
      const listed = record(models) && Array.isArray(models.models) ? models.models.filter(record) : [];
      result.modelsListed = listed.length;
      result.workshopModelInModelsList = listed.some((model) => model.modelId === pair.modelId && model.available === true);
      result.modelSelectSeconds = seconds(t);
      await save();
      assert.ok(result.workshopModelInModelsList, "workshop model missing from models.list");

      t = Date.now();
      const before = await memberUsage();
      await sendComposerMessage(surface, TASK_PROMPT);
      await waitForAssistantReply(surface, { timeoutMs: 240_000 });
      await waitFor(surface, () => {
        const busy = [...document.querySelectorAll("button")].some((button) => /^(stop|stop task|stop generating)$/i.test((button.getAttribute("aria-label") ?? button.textContent ?? "").trim()));
        return !busy && !document.querySelector('[data-status="pending"], [data-status="running"]');
      }, { timeoutMs: 240_000, label: "task finished" });
      const reply = await waitForAssistantReply(surface, { timeoutMs: 10_000 });
      let after = await memberUsage();
      for (let i = 0; i < 30 && after !== null && before !== null && after <= before; i++) { await new Promise((r) => setTimeout(r, 1000)); after = await memberUsage(); }
      const transcript = await control(surface, "session.read_transcript", { count: 30 }).catch(() => null);
      const calls = parseSessionToolCalls(transcript);
      result.taskSeconds = seconds(t);
      result.reply = redactWorkshopDiagnostic(reply.text, privateValues).slice(0, 600);
      result.replyMentionsNorthwind = /northwind/i.test(reply.text);
      result.toolCalls = calls.map((call) => call.capability);
      result.usedMicroUsdBefore = before;
      result.usedMicroUsdAfter = after;
      result.taskCostUsd = before !== null && after !== null ? (after - before) / 1_000_000 : null;
      await screenshot(surface, join(options.outputDir, "signin-task.png")).catch(() => undefined);
      result.ok = result.replyMentionsNorthwind === true && typeof result.taskCostUsd === "number" && result.taskCostUsd > 0;
    } catch (error) {
      result.ok = false;
      result.error = redact(error);
      await screenshot(surface, join(options.outputDir, "signin-failed.png")).catch(() => undefined);
      throw error;
    } finally { await save(); }
  }

  async function phaseCleanup() {
    const ids = [...report.clones.flatMap((entry) => entry.sandboxId && !entry.deleted ? [entry.sandboxId] : []),
      ...(report.base?.sandboxId && !report.base.deleted ? [report.base.sandboxId] : [])];
    for (const id of ids) assertOwned(id);
    const deleted: string[] = [], failed: string[] = [];
    await settledPool(ids, 6, async (id) => {
      try { await deleteSandboxes([id], { log: () => {} }); deleted.push(id); }
      catch { failed.push(id); }
    });
    for (const entry of report.clones) if (entry.sandboxId && deleted.includes(entry.sandboxId)) entry.deleted = true;
    if (report.base?.sandboxId && deleted.includes(report.base.sandboxId)) report.base.deleted = true;
    report.cleanup = { deleted: [...(report.cleanup?.deleted ?? []), ...deleted], failed, at: new Date().toISOString() };
    await save();
    log(`cleanup: deleted ${deleted.length}, failed ${failed.length}; snapshot ${report.snapshot?.name ?? "none"} kept`);
  }

  let failure: unknown;
  try {
    if (options.phase === "base" || options.phase === "all") await phaseBase();
    if (options.phase === "clones" || options.phase === "all") await phaseClones();
    if (options.phase === "signin" || options.phase === "all") await phaseSignIn();
  } catch (error) {
    failure = error;
    log(`FAILED: ${redact(error)}`);
  }
  if (options.phase === "cleanup") await phaseCleanup();
  await save();
  if (failure) process.exitCode = 1;
}

if (import.meta.main) await main();
