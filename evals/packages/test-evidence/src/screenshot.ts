import { createHash } from "node:crypto";
import { browserScript, captureScreenshot, evaluate } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { currentTestEvidence } from "./ambient.ts";
import { collectLayout, LAYOUT_BOX_LIMIT, parseLayoutSnapshot, type LayoutSnapshot } from "@openwork/design-review";
import type { EvidenceCheckpoint } from "@openwork/freestyle/checkpoint-schema";

export interface ScreenshotArtifact {
  png: Buffer;
  hash: string;
  route: string;
  visibleText: string;
  at: string;
  /** Text boxes on screen when the image was taken; absent when the page could not report them. */
  layout?: LayoutSnapshot;
  /** Set only on images taken by `takeCheckpoint`; plain screenshots never save one. */
  checkpoint?: EvidenceCheckpoint;
  /** "exact" when the screen did not change while the checkpoint was captured. */
  checkpointMatch?: "exact" | "approximate";
  checkpointError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Captures the surface without recording it as evidence. */
export async function captureFrame(app: Surface): Promise<ScreenshotArtifact> {
  const at = new Date().toISOString();
  const png = await captureScreenshot(app.client);
  const page = await evaluate(app.client, () => (({
    route: window.location.hash,
    visibleText: document.body.innerText,
  })));
  if (!isRecord(page) || typeof page.route !== "string" || typeof page.visibleText !== "string") {
    throw new Error("CDP did not return the current route and visible text for the screenshot.");
  }
  const layout = await captureLayout(app);
  return {
    png,
    hash: createHash("sha256").update(png).digest("hex"),
    route: page.route,
    visibleText: page.visibleText,
    at,
    ...(layout ? { layout } : {}),
  };
}

/** Layout is a design aid, never a reason to lose the screenshot itself. */
async function captureLayout(app: Surface): Promise<LayoutSnapshot | undefined> {
  try {
    return parseLayoutSnapshot(await evaluate(app.client, browserScript(collectLayout, [LAYOUT_BOX_LIMIT]))) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function screenshot(app: Surface, options?: { caption?: string }): Promise<ScreenshotArtifact> {
  const artifact = await captureFrame(app);
  currentTestEvidence()?.recordScreenshot(artifact, options);
  return artifact;
}
