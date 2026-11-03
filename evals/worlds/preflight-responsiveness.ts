import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Seed } from "@openwork/env";

const exec = promisify(execFile);

/** A bounded algorithm-level Electron witness, not a full desktop migration. */
export async function preflightResponsiveness(seed: Seed) {
  const directory = seed.tmpPath("synthetic-preflight");
  await mkdir(directory, { recursive: true });
  const electron = fileURLToPath(new URL("../../apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/preflight-heartbeat.mjs", import.meta.url));
  const { stdout } = await exec(electron, [fixture, directory], { timeout: 240_000, maxBuffer: 65536 });
  const line = stdout.split("\n").find(line => line.startsWith("PREFLIGHT_RESULT "));
  if (!line) throw new Error("Electron did not return preflight measurements");
  const data: unknown = JSON.parse(line.slice("PREFLIGHT_RESULT ".length));
  if (typeof data !== "object" || data === null) throw new Error("Invalid preflight measurement");
  const maxLag = Reflect.get(data, "maxLag");
  const stalls = Reflect.get(data, "stalls");
  if (typeof maxLag !== "number" || typeof stalls !== "number") throw new Error("Missing heartbeat evidence");
  return { result: { maxLag, stalls, raw: JSON.stringify(data),
    safe: Reflect.get(data, "unchanged") === true && Reflect.get(data, "targetAbsent") === true,
    exactRefusal: Reflect.get(data, "refusal") === Reflect.get(data, "expected"),
    electronMain: Reflect.get(data, "electronMain") === true } };
}
