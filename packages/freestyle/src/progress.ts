import type { Freestyle } from "freestyle";
import { client, type PreviewWorld } from "./index.ts";
import { buildLabel } from "./builder.ts";

/** Snapshot layers in build order. Tools and dependencies are usually cached. */
export type BuildLayer = "tools" | "dependencies" | "compiled" | "running-template" | "world";
export const BUILD_LAYERS: BuildLayer[] = ["tools", "dependencies", "compiled", "running-template", "world"];

/** A step that finished inside the builder VM, with how long it took. */
export interface BuildStep { id: string; ms: number }

export interface BuildProgress {
  building: boolean;
  /** The layer the newest live builder VM is preparing. */
  layer?: BuildLayer;
  /** When that builder VM started (ISO time). */
  since?: string;
  /** Steps finished inside that VM so far, in order (e.g. checkout, world-services). */
  steps: BuildStep[];
}

type ProgressApi = { vms: Pick<Freestyle["vms"], "list" | "ref"> };

// cache.ts names each builder VM "OpenWork <layer> builder".
const LAYER_BY_NAME = new Map<string, BuildLayer>(BUILD_LAYERS.map((layer) => [`OpenWork ${layer} builder`, layer]));
const ROOT = "/opt/openwork-preview";

async function finishedSteps(api: ProgressApi, vmId: string, file: string): Promise<BuildStep[]> {
  try {
    const fs = api.vms.ref(vmId).fs;
    if (!await fs.exists(`${ROOT}/${file}`)) return [];
    const steps: BuildStep[] = [];
    for (const line of (await fs.readTextFile(`${ROOT}/${file}`)).split("\n")) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; } // The last line may still be being written.
      if (typeof value === "object" && value !== null && "stage" in value && typeof value.stage === "string" && /^[a-z-]{1,40}$/.test(value.stage)
        && "durationMs" in value && typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0) {
        steps.push({ id: value.stage, ms: Math.round(value.durationMs) });
      }
    }
    return steps;
  } catch {
    return []; // A VM between states or a half-written line is not a failed build.
  }
}

/**
 * Reads what a first build of this commit is doing right now, from the builder
 * VMs tagged with it (see buildLabel). Between layers, and while the source tree
 * is read, no builder is alive; callers keep the furthest progress they saw.
 */
export async function buildProgress(sha: string, world: PreviewWorld, api: ProgressApi = client()): Promise<BuildProgress> {
  const { vms } = await api.vms.list({ metadata: `openworkBuild:${buildLabel(sha, world).openworkBuild}`, limit: 20 });
  const live = vms.filter((vm) => vm.state === "starting" || vm.state === "running")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const newest = live[0];
  if (!newest) return { building: false, steps: [] };
  const layer = LAYER_BY_NAME.get(newest.displayName ?? "");
  const steps = layer === "running-template"
    ? [...await finishedSteps(api, newest.id, "build-stages.jsonl"), ...await finishedSteps(api, newest.id, "runtime-stages.jsonl")]
    : [];
  return { building: true, ...(layer ? { layer } : {}), since: newest.createdAt, steps };
}
