import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { test } from "@openwork/testkit";
import { FEATURES } from "../../../packages/features/src/registry.ts";

// Explicitly named live proof: consumes the native sampler, main-thread and
// real-app receipts from an owned packaged-app run. It never substitutes a
// screenshot, a fixture HTML page or a mocked engine for those observations.
const proofDirectory = process.env.OPENWORK_LAUNCH_BROKER_PROOF_DIR;
const runtime = z.object({
  serverRunning: z.boolean(), generation: z.number(), workspaceCount: z.number(),
  v2: z.object({ running: z.boolean(), pid: z.number(), version: z.string(), hasError: z.boolean() }),
  legacy: z.object({ healthy: z.boolean(), version: z.string(), pid: z.number() }).nullable().optional(),
});
const summary = z.object({
  label: z.string(), variant: z.enum(["before", "after"]), faultMs: z.number(), brokerFlag: z.boolean(),
  firstWorkspaceMs: z.number().nullable(), runtime, samples: z.number(), hungSamples: z.number(),
  mainHeartbeatMaxGap: z.number(), mainEngineCreates: z.number(), mainInjected: z.boolean(),
  fatalBootAtEnd: z.boolean(), preparingAtEnd: z.boolean(), appVersion: z.string().optional(),
});
const instrument = z.object({
  pid: z.number(), flagOn: z.boolean(), injected: z.boolean(),
  beats: z.array(z.object({ ms: z.number(), gap: z.number() })),
  injection: z.object({ durationMs: z.number(), thread: z.enum(["main", "broker"]) }).optional(),
  events: z.array(z.object({ kind: z.string(), engine: z.boolean().optional(), v2: z.boolean().optional(), purpose: z.string().optional(), elapsed: z.number().optional(), pid: z.number().optional() })),
});
const launch = z.object({ nonAdmin: z.boolean(), normalHome: z.boolean(), normalUserProfile: z.boolean(), sessionId: z.number(), observeMs: z.number(), gateMs: z.number(), pid: z.number(), asarSha256: z.string().regex(/^[a-f0-9]{64}$/) });
const hung = z.array(z.object({ ms: z.number(), visible: z.boolean(), hung: z.boolean() }));
const tree = z.array(z.object({ processes: z.array(z.object({ pid: z.number(), ppid: z.number(), name: z.string(), purpose: z.string() })) }));
async function json(directory: string, name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(directory, name), "utf8"));
}
async function windowsCase(directory: string, label: string) {
  return {
    summary: summary.parse(await json(directory, `${label}.summary.json`)),
    launch: launch.parse(await json(directory, `${label}.launch.json`)),
    main: instrument.parse(await json(directory, `${label}.main.json`)),
    hung: hung.parse(await json(directory, `${label}.hung.json`)),
    tree: tree.parse(await json(directory, `${label}.tree.json`)),
  };
}
function usable(state: z.infer<typeof summary>) {
  expect(state.runtime.serverRunning).toBe(true);
  expect(state.runtime.generation).toBe(1);
  expect(state.runtime.workspaceCount).toBeGreaterThan(0);
  expect(state.runtime.v2.running).toBe(true);
  expect(state.runtime.v2.version).toBe("2.0.26");
  expect(state.runtime.v2.hasError).toBe(false);
  expect(state.firstWorkspaceMs).not.toBeNull();
  expect(state.fatalBootAtEnd).toBe(false);
  expect(state.preparingAtEnd).toBe(false);
}

test("native Windows proof: the same 12 s engine admission stalls dev main, not the enabled broker", async ({ skip, evidence }) => {
  if (!proofDirectory) return skip("needs: OPENWORK_LAUNCH_BROKER_PROOF_DIR with packaged native Windows receipts");
  evidence.setEngine("v2");
  const before = await windowsCase(proofDirectory, "before-delay-final");
  const after = await windowsCase(proofDirectory, "after-delay-final");
  const broker = instrument.parse(await json(proofDirectory, "after-delay-final.broker.json"));
  const identity = z.object({ source: z.string(), installerSha256: z.string(), signature: z.string() });
  const baselineIdentity = identity.parse(await json(proofDirectory, "before-install.json"));
  const candidateIdentity = identity.parse(await json(proofDirectory, "after-install.json"));
  expect(baselineIdentity).toEqual({ source: "866db910ef214ce8c5d2377a662473990062acf5", installerSha256: "402d4fdffc7a72e27c44ddfadbf084a060597b03fa2457b46644633684b8bfae", signature: "Valid" });
  expect(candidateIdentity).toEqual({ source: "0600ac111ac2b40b751d9327b1a293256a96aa54", installerSha256: "e26586d3548f3035ff997dfee313b4ac18205cfb8293cd6941925109e0d4ed90", signature: "Valid" });
  expect(FEATURES.desktopLaunchBroker.default).toBe(false);
  for (const record of [before, after]) {
    expect(record.launch.nonAdmin).toBe(true);
    expect(record.launch.normalHome).toBe(true);
    expect(record.launch.normalUserProfile).toBe(true);
    expect(record.launch.sessionId).toBeGreaterThan(0);
    expect(record.launch.observeMs).toBe(180_000);
    expect(record.launch.gateMs).toBe(5_000);
    const visible = record.hung.filter(sample => sample.visible);
    expect(visible.length).toBeGreaterThan(300);
    expect(visible.at(-1)!.ms - visible[0]!.ms).toBeGreaterThanOrEqual(179_000);
    expect(record.summary.hungSamples).toBe(record.hung.filter(sample => sample.hung).length);
    expect(record.summary.mainHeartbeatMaxGap).toBe(Math.max(...record.main.beats.map(beat => beat.gap)));
    expect(record.summary.mainEngineCreates).toBe(record.main.events.filter(event => event.kind === "native-create" && event.engine).length);
    usable(record.summary);
  }
  expect(before.launch.asarSha256).not.toBe(after.launch.asarSha256);
  expect(before.summary.brokerFlag).toBe(false);
  expect(before.summary.mainInjected).toBe(true);
  expect(before.main.injection).toEqual(expect.objectContaining({ durationMs: 12_000, thread: "main" }));
  expect(before.summary.hungSamples).toBeGreaterThan(0);
  expect(before.summary.mainHeartbeatMaxGap).toBeGreaterThanOrEqual(12_000);
  expect(before.summary.mainEngineCreates).toBeGreaterThan(0);
  expect(after.summary.brokerFlag).toBe(true);
  expect(after.summary.mainInjected).toBe(false);
  expect(after.summary.mainEngineCreates).toBe(0);
  expect(after.summary.hungSamples).toBe(0);
  expect(after.summary.mainHeartbeatMaxGap).toBeLessThan(5_000);
  expect(broker.injected).toBe(true);
  expect(broker.injection).toEqual(expect.objectContaining({ durationMs: 12_000, thread: "broker" }));
  expect(broker.events.some(event => event.engine && event.v2 && event.purpose === "serve" && (event.elapsed ?? 0) >= 12_000)).toBe(true);
  const enginePid = after.summary.runtime.v2.pid;
  expect(after.tree.some(snapshot => snapshot.processes.some(process => process.pid === enginePid && process.ppid === broker.pid && process.ppid !== after.launch.pid))).toBe(true);
  evidence.recordAssertionEvidence("The same native admission delay no longer hangs Windows UI main",
    `Dev: ${before.summary.hungSamples}/${before.hung.length} hung samples, ${before.summary.mainHeartbeatMaxGap} ms main gap; enabled broker: ${after.summary.hungSamples}/${after.hung.length}, ${after.summary.mainHeartbeatMaxGap} ms gap, zero main engine creates. Both v2 workspaces usable.`, true);
  evidence.recordJsonArtifact("Matched signed native Windows measurements", { baselineIdentity, candidateIdentity, before, after, broker });
});

test("native Windows proof: clean and second launches keep v2 and legacy health usable with no stuck overlay", async ({ skip, evidence }) => {
  if (!proofDirectory) return skip("needs: OPENWORK_LAUNCH_BROKER_PROOF_DIR with clean/second launch receipts");
  evidence.setEngine("v2");
  const clean = await windowsCase(proofDirectory, "after-clean");
  const second = await windowsCase(proofDirectory, "after-second");
  for (const record of [clean, second]) {
    usable(record.summary);
    expect(record.summary.brokerFlag).toBe(true);
    expect(record.summary.faultMs).toBe(0);
    expect(record.summary.hungSamples).toBe(0);
    expect(record.summary.mainEngineCreates).toBe(0);
    expect(record.summary.runtime.legacy?.healthy).toBe(true);
    expect(record.summary.runtime.legacy?.version).toBe("1.18.30");
    expect(record.summary.appVersion).toBe("0.18.60-alpha.3639.1+0600ac1");
    expect(record.launch.gateMs).toBe(0);
  }
  expect(second.summary.runtime.workspaceCount).toBe(clean.summary.runtime.workspaceCount);
  expect(second.summary.runtime.v2.pid).not.toBe(clean.summary.runtime.v2.pid);
  const quit = z.object({ engines: z.number(), apps: z.number() }).parse(await json(proofDirectory, "after-second.quit.json"));
  expect(quit.engines).toBe(0);
  expect(quit.apps).toBe(0);
  evidence.recordAssertionEvidence("Clean and persisted second launches stay usable and quit cleanly",
    `Clean: ${clean.summary.hungSamples}/${clean.hung.length} hung samples; second: ${second.summary.hungSamples}/${second.hung.length}. V2 and legacy HTTP health remain usable, workspace count is preserved, and quit leaves no apps or engines.`, true);
  evidence.recordJsonArtifact("Clean and second Windows launch measurements", { clean, second, quit });
});

test("native Windows proof: a real broker crash reaps admitted engines and leaves UI main responsive", async ({ skip, evidence }) => {
  if (!proofDirectory) return skip("needs: OPENWORK_LAUNCH_BROKER_PROOF_DIR with crash reaper receipt");
  evidence.setEngine("v2");
  // This is the separate, explicitly non-fault candidate run. Its failed
  // preload attempt is not used as the matched 12 s admission result above.
  const crash = z.object({ beforePids: z.array(z.number()), remainingEngineCount: z.number(), mainResponsive: z.boolean() }).parse(await json(proofDirectory, "after-delay.crash.json"));
  expect(crash.beforePids.length).toBeGreaterThanOrEqual(2);
  expect(crash.remainingEngineCount).toBe(0);
  expect(crash.mainResponsive).toBe(true);
  evidence.recordAssertionEvidence("A real broker crash reaps admitted engines without replaying creation",
    `${crash.beforePids.length} engines before crash; ${crash.remainingEngineCount} afterwards; main still responds. The separate no-fault candidate run is not used as the matched delay result.`, true);
  evidence.recordJsonArtifact("Actual Windows crash reaper measurement", crash);
});

test("packaged macOS proof: enabled broker opens a workspace on first and second launch", async ({ skip, evidence }) => {
  if (!proofDirectory) return skip("needs: OPENWORK_LAUNCH_BROKER_PROOF_DIR with packaged macOS receipt");
  evidence.setEngine("v2");
  const result = z.object({ isPackaged: z.boolean(), sourceSha: z.string(), launches: z.array(z.object({ flagOn: z.boolean(), appVersion: z.string(), workspaceCount: z.number(), v2Running: z.boolean(), v2Pid: z.number(), v2Version: z.string(), generation: z.number(), preparing: z.boolean(), fatalBoot: z.boolean(), mainEngineCreates: z.number(), electron: z.string(), mainHeartbeatMaxGap: z.number(), workspaceMs: z.number() })) }).parse(await json(proofDirectory, "mac-smoke.json"));
  expect(result.isPackaged).toBe(true);
  expect(result.sourceSha).toBe("0600ac111ac2b40b751d9327b1a293256a96aa54");
  expect(result.launches).toHaveLength(2);
  for (const launch of result.launches) {
    expect(launch.flagOn).toBe(true);
    expect(launch.appVersion).toBe("0.18.60-alpha.3639.1");
    expect(launch.workspaceCount).toBeGreaterThan(0);
    expect(launch.v2Running).toBe(true);
    expect(launch.v2Version).toBe("2.0.26");
    expect(launch.generation).toBe(1);
    expect(launch.preparing).toBe(false);
    expect(launch.fatalBoot).toBe(false);
    expect(launch.mainEngineCreates).toBe(0);
  }
  expect(result.launches[0]!.v2Pid).not.toBe(result.launches[1]!.v2Pid);
  evidence.recordAssertionEvidence("The packaged macOS app opens a healthy workspace twice with the broker enabled",
    `Both launches report isPackaged=true, enabled broker, healthy v2, a preserved workspace and no boot error; native main creates no engines and the second launch owns a new engine pid.`, true);
  evidence.recordJsonArtifact("Packaged macOS first and second launch measurements", result);
});
