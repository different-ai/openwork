import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { attachSurface, callFunctionOnSurface, emulateFocus, freezeMotion, navigate, setViewport } from "@openwork/cdp";
import { setTimeout as delay } from "node:timers/promises";
import type { Surface } from "@openwork/cdp";
import { docShotReceiptSchema } from "@openwork/review";
import { Ctx, provider } from "../ctx.ts";
import { gate } from "../gate.ts";
import { captureUntil } from "../loop.ts";
import { REPO_ROOT } from "../surfaces.ts";
import { DEFAULT_VIEWPORT } from "./shot.ts";
import type { Shot } from "./shot.ts";

/** Read-only captures. The paid proof owns the world, prompts and all business writes. */
export const WORKSHOP_SHOT_IDS = [
  "workshop-before-regression", "workshop-after-regression",
  "workshop-t02-context", "workshop-t03-context",
  "workshop-t01-final", "workshop-t02-final", "workshop-t03-final",
  "workshop-t04-final", "workshop-t05-final", "workshop-t06-final",
  "workshop-t07-final", "workshop-t08-final", "workshop-t09-final",
  "workshop-t10-final", "workshop-t11-final", "workshop-t12-final",
] as const;
export type WorkshopShotId = typeof WORKSHOP_SHOT_IDS[number];
export interface WorkshopFrame {
  /** Use exact object/result text, not just persistent navigation chrome. */
  expect: readonly string[];
  never?: readonly string[];
  route: RegExp;
}

export function workshopStateHash(value: unknown): string {
  // Normalize object key order, preserving arrays: two GETs may serialize keys differently.
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") return Object.fromEntries(
      Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]),
    );
    return item;
  };
  const json = JSON.stringify(canonical(value));
  if (json === undefined) throw new Error("Workshop readState must return JSON business state.");
  return createHash("sha256").update(json).digest("hex");
}

function outputDirectory(directory: string): string {
  const root = resolve(REPO_ROOT, "evals/results/workshop-docshots");
  const result = resolve(REPO_ROOT, directory);
  const child = relative(root, result);
  if (!child || child.startsWith(`..${sep}`) || child === ".." || resolve(root, child) !== result) {
    throw new Error("Workshop DocShots need a named run beneath evals/results/workshop-docshots/.");
  }
  return result;
}
function outputPath(directory: string, id: WorkshopShotId): string {
  return resolve(outputDirectory(directory), `${id}.png`);
}
function frameGate(frame: WorkshopFrame) {
  if (!frame.expect.length || frame.expect.some((text) => !text.trim())) throw new Error("A workshop frame needs object-specific expected text.");
  if (frame.route.global || frame.route.sticky) throw new Error("Workshop route gates cannot be stateful regular expressions.");
  // ScreenshotArtifact.route is location.hash, not the pathname of connected
  // services. Validate their full URL on the native surface, not a fabricated hash.
  const accepts = gate({ expect: frame.expect, never: frame.never });
  return (artifact: Parameters<typeof accepts>[0]) => accepts(artifact)
    && frame.expect.every((text) => (artifact.viewportText ?? artifact.visibleText).includes(text));
}
async function assertRoute(surface: Surface, route: RegExp): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const url = await callFunctionOnSurface(surface, () => location.href, []);
    if (route.test(decodeURIComponent(url))) return;
    await delay(200);
  }
  throw new Error("Workshop browser did not reach the expected full product URL.");
}
function existingSurfaceShot(id: WorkshopShotId, surface: Surface, frame: WorkshopFrame, directory: string): Shot {
  const use = provider(async () => surface);
  return {
    id, out: relative(REPO_ROOT, outputPath(directory, id)), gate: frameGate(frame),
    run: async (ctx) => {
      const target = await ctx.use(use);
      await assertRoute(target, frame.route);
      return target;
    },
  };
}

/** A native context adapter, not a replacement screenshot harness or a second world.
 * readState must GET only business data (omit volatile audit timestamps/messages).
 * A before/after pair must use the SAME saved state, not reseeded or replayed writes.
 */
export function createWorkshopShotContext(options: {
  directory: string;
  readState: () => Promise<unknown>;
  assertSafe: (surface: Surface) => Promise<void>;
}) {
  const directory = outputDirectory(options.directory);
  const ctx = new Ctx();
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const captured = new Set<WorkshopShotId>();
  let comparisonState: string | undefined;
  return {
    directory,
    async capture(id: WorkshopShotId, surface: Surface, frame: WorkshopFrame) {
      if (captured.has(id)) throw new Error(`Workshop DocShot already captured: ${id}`);
      const shot = existingSurfaceShot(id, surface, frame, directory);
      const stateSha256 = workshopStateHash(await options.readState());
      if (id === "workshop-after-regression" && (!comparisonState || stateSha256 !== comparisonState)) {
        throw new Error("After regression requires a captured before frame with identical business state.");
      }
      const target = await shot.run(ctx);
      await setViewport(target, DEFAULT_VIEWPORT);
      await emulateFocus(target); // CDP only: never bring a macOS window to the foreground.
      await freezeMotion(target);
      await options.assertSafe(target);
      const png = await captureUntil(target, shot.gate);
      await options.assertSafe(target);
      await assertRoute(target, frame.route);
      if (workshopStateHash(await options.readState()) !== stateSha256) {
        throw new Error("Business state changed during DocShot capture; refusing a same-state claim.");
      }
      const file = outputPath(directory, id);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, png);
      const receipt = `${file}.review.json`;
      await writeFile(receipt, JSON.stringify(docShotReceiptSchema.parse({
        schemaVersion: 1, kind: "docshot", name: id, gitSha: sourceSha,
        createdAt: new Date().toISOString(), fileName: basename(file),
      }), null, 2));
      await writeFile(`${file}.state.json`, JSON.stringify({
        schemaVersion: 1, name: id, stateSha256,
        comparison: id === "workshop-after-regression" ? "same-business-state" : id === "workshop-before-regression" ? "comparison-baseline" : "observed-final-state",
        // A DocShot is a visual reference, never a native assertion verdict.
        verdictSource: "native-proof-only",
      }, null, 2));
      captured.add(id);
      if (id === "workshop-before-regression") comparisonState = stateSha256;
      return { file, receipt, stateSha256, bytes: png.byteLength };
    },
    dispose: () => ctx.dispose(), // Native surfaces remain owned by the parent world.
  };
}

interface AttachedFrame {
  cdpUrl: string;
  url: string;
  expect: string[];
  never: string[];
  route: string;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workshop DocShot manifest record.");
  return Object.fromEntries(Object.entries(value));
}
function localUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Workshop capture needs an existing local browser URL.");
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Workshop CLI only attaches to owned loopback HTTP surfaces.");
  }
  return value;
}
function texts(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) throw new Error("Workshop gate text must be an array of strings.");
  return value;
}
/** The CLI manifest contains endpoints and gates, never tokens, model config or task data. */
export function parseWorkshopAttachment(value: unknown, id: WorkshopShotId): AttachedFrame {
  const manifest = record(value);
  if (manifest.organization !== "Acme Robotics" || manifest.fictional !== true) throw new Error("Workshop CLI requires the approved fictional Acme Robotics organization.");
  const frame = record(record(manifest.frames)[id]);
  if (typeof frame.route !== "string" || !frame.route) throw new Error("Workshop CLI requires an exact product route gate.");
  const result = { cdpUrl: localUrl(frame.cdpUrl), url: localUrl(frame.url), expect: texts(frame.expect), never: texts(frame.never ?? []), route: frame.route };
  frameGate({ ...result, route: new RegExp(result.route) });
  return result;
}

const attachedManifest = provider(async () => {
  const file = process.env.OPENWORK_WORKSHOP_DOCSHOT_INPUT;
  if (!file) throw new Error("Set OPENWORK_WORKSHOP_DOCSHOT_INPUT to the parent world's read-only attachment manifest. No world or model will be started.");
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  return parsed;
});
const directory = process.env.OPENWORK_WORKSHOP_DOCSHOT_DIR ?? "evals/results/workshop-docshots/attached";

/** Registered CLI scenes use the same real gate and run-scoped Ctx as docs scenes.
 * Native proof captures above additionally attest unchanged business state. CLI
 * captures alone do NOT attest a same-state comparison or any scene success.
 */
export const workshopShots: Shot[] = WORKSHOP_SHOT_IDS.map((id) => {
  let accepts: ReturnType<typeof frameGate> | undefined;
  return {
    id, out: relative(REPO_ROOT, outputPath(directory, id)),
    gate: (artifact) => accepts?.(artifact) ?? false,
    run: async (ctx) => {
      const frame = parseWorkshopAttachment(await ctx.use(attachedManifest), id);
      const surface = await attachSurface({ name: id, kind: "chrome", hostKind: "local", cdpUrl: frame.cdpUrl });
      ctx.onDispose(() => surface.stop()); // Close our CDP socket, not the parent's browser.
      accepts = frameGate({ ...frame, route: new RegExp(frame.route) });
      await navigate(surface.client, frame.url);
      await assertRoute(surface, new RegExp(frame.route));
      return surface;
    },
  };
});
