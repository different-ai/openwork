import { readFile } from "node:fs/promises";
import { DaytonaApi, DaytonaApiError, daytonaConfig } from "../../packages/daytona-evidence/src/api.ts";
import { demoSnapshotName, MAX_DEMO_DISK, parseDemoSource } from "./demo-options.ts";

export const DEMO_CPU = 4;
export const DEMO_MEMORY = 8;
export const DEMO_AUDIT = "demo-clean-base-v1: passed";
export const demoManifest = new URL("../../scripts/demo/snapshots.json", import.meta.url);
export const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export interface DemoSnapshot {
  id: string;
  image: string;
  sourceSandboxId: string;
  source: string;
  packageSha256: string;
  diskGiB: number;
  audit: typeof DEMO_AUDIT;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDemoSnapshot(value: unknown): DemoSnapshot {
  if (!isRecord(value) || typeof value.id !== "string" || !idPattern.test(value.id)
    || typeof value.sourceSandboxId !== "string" || !idPattern.test(value.sourceSandboxId)
    || typeof value.image !== "string" || !/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(value.image)
    || typeof value.packageSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.packageSha256)
    || typeof value.diskGiB !== "number" || !Number.isInteger(value.diskGiB) || value.diskGiB < 10 || value.diskGiB > MAX_DEMO_DISK
    || value.audit !== DEMO_AUDIT || typeof value.source !== "string" || parseDemoSource(value.source).source !== value.source) {
    throw new Error("Invalid demo snapshot review entry (identity, source, package digest, disk or audit missing).");
  }
  return { id: value.id, image: value.image, sourceSandboxId: value.sourceSandboxId, source: value.source,
    packageSha256: value.packageSha256, diskGiB: value.diskGiB, audit: value.audit };
}

export function reviewedDemoSnapshot(manifest: unknown, name: string): DemoSnapshot {
  demoSnapshotName(name);
  if (!isRecord(manifest) || !Object.hasOwn(manifest, name)) throw new Error(`No reviewed entry for ${name} in scripts/demo/snapshots.json.`);
  return parseDemoSnapshot(manifest[name]);
}

export function verifyDemoSnapshot(name: string, expected: DemoSnapshot, actual: unknown): void {
  if (!isRecord(actual) || actual.state !== "active" || actual.name !== name || actual.id !== expected.id
    || actual.ref !== expected.image || actual.sourceSandboxId !== expected.sourceSandboxId
    || actual.cpu !== DEMO_CPU || actual.mem !== DEMO_MEMORY || actual.disk !== expected.diskGiB) {
    throw new Error(`Daytona snapshot ${name} does not match the reviewed provenance or resources.`);
  }
}

export async function readReviewedDemoSnapshot(name: string): Promise<DemoSnapshot> {
  return reviewedDemoSnapshot(JSON.parse(await readFile(demoManifest, "utf8")), name);
}

export function demoDaytonaApi() {
  if (!process.env.DAYTONA_API_URL?.trim()) throw new Error("Set DAYTONA_API_URL and DAYTONA_API_KEY for the same Daytona team (CLI and REST).");
  return new DaytonaApi(daytonaConfig());
}

export async function getRawDemoSnapshot(api: DaytonaApi, name: string): Promise<unknown> {
  try { return await api.call("GET", `/snapshots/${encodeURIComponent(name)}`); }
  catch (error) { if (error instanceof DaytonaApiError && error.status === 404) return null; throw new Error("Could not inspect Daytona snapshot metadata."); }
}
