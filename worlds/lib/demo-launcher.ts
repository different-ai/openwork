import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { guardDemoBudget, parseDemoOptions } from "./demo-options.ts";
import { demoPrivateDir, readSeatControl, writeSeatControl } from "./demo-output.ts";
import type { SeatControl } from "./demo-output.ts";
import type { DemoSnapshot } from "./demo-snapshot.ts";

export interface DemoProvider {
  review(name: string): Promise<DemoSnapshot>;
  create(name: string, snapshot: DemoSnapshot, lifetime: number): Promise<string>;
  prepare(id: string, timezone: string): Promise<void>;
  viewer(id: string, expiresAt: string): Promise<{ viewer: string; viewerExpiresAt: string }>;
  remove(idOrName: string): Promise<void>;
}

/** A fresh stage is a journal: record the unique name before dispatching create. */
export async function launchDemo(dir: string, argv: readonly string[], provider: DemoProvider) {
  const options = parseDemoOptions(argv);
  const snapshot = await provider.review(options.snapshot);
  const estimate = guardDemoBudget(options, snapshot.diskGiB);
  // Do not overwrite a previous run, even if its resources were stopped.
  await demoPrivateDir(dir, true, true);
  const lock = join(dir, ".busy");
  await mkdir(lock, { mode: 0o700 });
  const owned: SeatControl[] = [];
  try {
    for (const seat of options.seats) {
      const seatDir = await demoPrivateDir(join(dir, seat));
      const control: SeatControl = { seat, sandbox: randomUUID(), expiresAt: new Date(Date.now() + options.lifetime * 60_000).toISOString(), cdpReachable: false };
      await writeSeatControl(seatDir, control);
      owned.push(control);
      control.sandbox = await provider.create(control.sandbox, snapshot, options.lifetime);
      await writeSeatControl(seatDir, control);
      await provider.prepare(control.sandbox, options.timezone);
      control.cdpReachable = true;
      Object.assign(control, await provider.viewer(control.sandbox, control.expiresAt));
      await writeSeatControl(seatDir, control);
    }
    return { directory: dir, ready: `${owned.length}/${options.seats.length}`, infrastructureEstimateUsd: estimate };
  } catch {
    const cleanup = await Promise.allSettled(owned.map(async (control) => {
      await provider.remove(control.sandbox);
      await writeSeatControl(join(dir, control.seat), { ...control, viewer: undefined, viewerExpiresAt: undefined, stopped: true, cdpReachable: false });
    }));
    throw new Error(cleanup.some((result) => result.status === "rejected")
      ? "Demo launch failed; cleanup incomplete. Retry down using the private receipts; provider TTL remains the backstop."
      : "Demo launch failed; owned sandboxes removed. Start a new stage to retry.");
  } finally { await rm(lock, { recursive: true }); }
}

/** Refresh and cleanup use only the selected stage's receipts, never a fleet query. */
export async function manageDemo(dir: string, action: "refresh" | "down", provider: DemoProvider) {
  await demoPrivateDir(dir, false);
  const lock = join(dir, ".busy");
  await mkdir(lock, { mode: 0o700 });
  try { return await manageLockedDemo(dir, action, provider); }
  finally { await rm(lock, { recursive: true }); }
}

async function manageLockedDemo(dir: string, action: "refresh" | "down", provider: DemoProvider) {
  const seats = (await readdir(dir)).filter((name) => name !== ".busy");
  const failed: string[] = [];
  for (const seat of seats) {
    try {
      const seatDir = await demoPrivateDir(join(dir, seat), false);
      const control = await readSeatControl(seatDir, seat);
      if (control.stopped) continue;
      if (action === "down") {
        await provider.remove(control.sandbox);
        await writeSeatControl(seatDir, { ...control, viewer: undefined, viewerExpiresAt: undefined, stopped: true, cdpReachable: false });
      } else {
        if (Date.parse(control.expiresAt) <= Date.now()) throw new Error("Expired seat.");
        await provider.prepare(control.sandbox, "");
        await writeSeatControl(seatDir, { ...control, ...await provider.viewer(control.sandbox, control.expiresAt), cdpReachable: true });
      }
    } catch { failed.push(seat); }
  }
  if (failed.length) throw new Error(`Demo ${action} incomplete for ${failed.length} seat(s); inspect private receipts and retry. No links logged.`);
  return { directory: dir, action };
}
