import { browserScript } from "@openwork/cdp";
import { evalIn } from "@openwork/behaviors";
import type { Place, Seed } from "@openwork/env";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { holdNewOwnedRuntime } from "./packaged-sandbox-startup-hold.ts";
import { ownedMicrosandboxProcesses, packagedBundle } from "./packaged-sandbox-fixtures.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sandboxFlagOffDesktop, sandboxManagedDesktop, sandboxOnlyDesktop, sandboxUnavailableDesktop } from "./sandbox-only.ts";

/**
 * Deterministic packaged-smoke counterpart of packaged-sandbox-check.ts.
 * Only inference is scripted; Electron, app.asar, the embedded server, plugin,
 * microsandbox and the live absolute-path bind mounts are the shipping artifact.
 * Set the same packaged-smoke binary/prepared-resource variables as the updater gate.
 */
async function packagedWorld<T extends Awaited<ReturnType<typeof sandboxManagedDesktop>>>(build: () => Promise<T>) {
  const binary = process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim();
  if (!binary) throw new Error("Set OPENWORK_EVAL_ELECTRON_BINARY to the branch-built .app executable");
  const artifact = await packagedBundle(binary);
  const world = await build();
  try {
    const isPackaged = await evalIn(world.app, browserScript(() => {
      const meta: unknown = Reflect.get(window.__OPENWORK_ELECTRON__, "meta");
      return typeof meta === "object" && meta !== null && Reflect.get(meta, "isPackaged") === true;
    }, []));
    if (isPackaged !== true) throw new Error("The packaged regression accidentally launched development Electron");
    let startupHold: Awaited<ReturnType<typeof holdNewOwnedRuntime>> | undefined;
    async function resumeHeldRuntime() {
      if (!startupHold) return null;
      const receipt = await startupHold.resume();
      if (!receipt.stopVerified || receipt.readyVerified) return receipt;
      const deadline = Date.now() + 90_000;
      let last: unknown;
      while (Date.now() < deadline) {
        const result = await evalIn(world.app, browserScript(async (path) => {
          const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
          const response = await fetch(`${String(info.baseUrl).replace(/\/+$/, "")}${path}`, {
            headers: { authorization: `Bearer ${info.ownerToken ?? info.clientToken ?? ""}` }, signal: AbortSignal.timeout(10_000),
          });
          const body: unknown = await response.json();
          return { status: response.status, body };
        }, [world.settingsPath]), { awaitPromise: true }).catch(error => ({ status: 0, body: String(error) }));
        last = result;
        if (result.status === 200 && typeof result.body === "object" && result.body !== null && "runtime" in result.body) {
          const runtime = result.body.runtime;
          if (typeof runtime === "object" && runtime !== null && "state" in runtime && runtime.state === "ready") {
            receipt.readyVerified = true;
            return receipt;
          }
        }
        await delay(100);
      }
      receipt.state = "blocked";
      receipt.detail = `The owned guest was resumed, but real sandbox readiness was not restored: ${JSON.stringify(last)}`;
      throw new Error(JSON.stringify(receipt));
    }
    return {
      ...world, artifact, isPackaged,
      async holdNewOwnedRuntime() {
        if (startupHold) throw new Error("This world already armed a startup slowdown");
        const pid = world.app.handle.pid;
        if (!pid) throw new Error("The packaged app has no owned process ID; refusing to arm a startup slowdown");
        startupHold = await holdNewOwnedRuntime(pid, {
          snapshot: async () => (await promisify(execFile)("ps", ["-axo", "pid=,ppid=,command="], { timeout: 5_000 })).stdout,
          state: async pid => {
            try { return (await promisify(execFile)("ps", ["-o", "stat=", "-p", String(pid)], { timeout: 5_000 })).stdout.trim() || null; }
            catch (error) {
              if (error instanceof Error && "code" in error && error.code === 1) return null;
              throw error;
            }
          },
          signal: (pid, signal) => { process.kill(pid, signal); },
        });
        return startupHold;
      },
      resumeHeldRuntime,
      startupHoldReceipt: () => startupHold?.receipt ?? null,
      async [Symbol.asyncDispose]() {
        const errors: unknown[] = [];
        if (startupHold) {
          try { await startupHold.dispose(); }
          catch (error) { errors.push(error); }
          finally {
            try { await resumeHeldRuntime(); }
            catch (error) { errors.push(error); }
            if (errors.length) console.error("Controlled startup slowdown cleanup:", JSON.stringify(startupHold.receipt));
          }
        }
        try { await world[Symbol.asyncDispose](); }
        catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, "Packaged proof cleanup was blocked; see the controlled startup slowdown receipt");
      },
      async crashOwnedIdleRuntime() {
        const pid = world.app.handle.pid;
        if (!pid) throw new Error("The packaged app has no owned process ID; refusing to target a VM");
        const snapshot = await promisify(execFile)("ps", ["-axo", "pid=,ppid=,command="]);
        const owned = ownedMicrosandboxProcesses(snapshot.stdout, pid);
        if (owned.length !== 1 || !owned[0]) throw new Error(`Expected exactly one owned guest, found ${owned.length}; refusing to send a signal`);
        const target = owned[0];
        process.kill(target.pid, "SIGKILL");
        return target;
      },
    };
  } catch (error) { await world[Symbol.asyncDispose](); throw error; }
}

export const packagedSandboxRegression = (seed: Seed, context: { place: Place }) =>
  packagedWorld(() => sandboxOnlyDesktop(seed, context));

export const packagedSandboxFlagOff = (seed: Seed, context: { place: Place }) =>
  packagedWorld(() => sandboxFlagOffDesktop(seed, context));

export const packagedSandboxManaged = (seed: Seed, context: { place: Place }) =>
  packagedWorld(() => sandboxManagedDesktop(seed, context));

export async function packagedSandboxManagedComputer(seed: Seed, context: { place: Place }) {
  return packagedWorld(async () => {
    const world = await sandboxManagedDesktop(seed, context);
    try {
      const saved = await seed.api(world.den.admin, world.teamPath, {
        method: "PUT", headers: { "X-OpenWork-Sandbox-Only": "1" },
        body: JSON.stringify({ settings: { hostExecution: { decision: "allow" } } }),
      });
      if (!saved.response.ok) throw new Error(`Arranging the managed computer choice failed: HTTP ${saved.response.status}`);
      return world;
    } catch (error) { await world[Symbol.asyncDispose](); throw error; }
  });
}

/** A real filesystem failure in this world's own runtime home; no fake status response. */
export async function packagedSandboxUnavailable(seed: Seed, context: { place: Place }) {
  const world = await packagedWorld(() => sandboxUnavailableDesktop(seed, context));
  return {
    ...world,
    repairOwnedRuntime: () => rm(join(world.sandboxHome, "unavailable")),
  };
}
