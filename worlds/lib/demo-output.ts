import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { output } from "../../packages/world/src/outputs.ts";
import { demoSeat, demoStage } from "./demo-options.ts";
import { idPattern, isRecord } from "./demo-snapshot.ts";

export interface SeatControl {
  seat: string;
  sandbox: string;
  expiresAt: string;
  cdpReachable: boolean;
  viewer?: string;
  viewerExpiresAt?: string;
  stopped?: boolean;
}

async function outsideCheckout(path: string) {
  for (let dir = path; dir !== dirname(dir); dir = dirname(dir)) {
    const git = await lstat(join(dir, ".git")).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") return null;
      throw error;
    });
    if (git) throw new Error("Demo output must not be inside a Git checkout.");
  }
}

export async function demoPrivateDir(path: string, create = true, exclusive = false) {
  // Reject checkout paths before writing, including paths through symlinks.
  const parent = await realpath(dirname(path));
  await outsideCheckout(parent);
  if (create) await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (exclusive || !isRecord(error) || error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700 || await realpath(path) !== join(parent, path.split("/").at(-1) ?? "")) {
    throw new Error("Demo output directory must be caller-owned, mode 0700, and not a symlink.");
  }
  await outsideCheckout(await realpath(path));
  return path;
}

export async function demoRootDir(create = true) {
  const parent = join(homedir(), ".openwork");
  if (create) {
    await outsideCheckout(await realpath(homedir()));
    await mkdir(parent, { mode: 0o700, recursive: true });
  }
  await demoPrivateDir(parent, false);
  return demoPrivateDir(join(parent, "demos"), create);
}

export async function demoStageDir(stage: string, create = true) {
  demoStage(stage);
  return demoPrivateDir(join(await demoRootDir(create), stage), create);
}

export async function writeDemoJson(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}

export async function writeSeatControl(dir: string, control: SeatControl) {
  await writeDemoJson(join(dir, "control.json"), control);
}

export async function readSeatControl(dir: string, seat: string): Promise<SeatControl> {
  const path = join(dir, "control.json");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new Error("Invalid private seat receipt permissions.");
  const data: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(data) || data.seat !== demoSeat(seat) || typeof data.sandbox !== "string" || !idPattern.test(data.sandbox)
    || typeof data.expiresAt !== "string" || !Number.isFinite(Date.parse(data.expiresAt)) || typeof data.cdpReachable !== "boolean") {
    throw new Error("Invalid demo seat receipt.");
  }
  return { seat, sandbox: data.sandbox, expiresAt: data.expiresAt, cdpReachable: data.cdpReachable,
    ...(data.stopped === true ? { stopped: true } : {}),
    ...(typeof data.viewer === "string" && typeof data.viewerExpiresAt === "string" ? { viewer: data.viewer, viewerExpiresAt: data.viewerExpiresAt } : {}) };
}

/** Never pass links to world outputs/events/logs, even as secret output values. */
export function demoWorldOutputs(dir: string, controls: readonly SeatControl[], total: number) {
  return { directory: output(dir), ready: output(`${controls.filter((seat) => seat.viewer && seat.cdpReachable).length}/${total}`) };
}
