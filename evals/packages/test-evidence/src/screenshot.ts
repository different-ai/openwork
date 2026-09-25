import { createHash } from "node:crypto";
import { captureScreenshot, evaluate } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { currentTestEvidence } from "./ambient.ts";
import { captureScreenshotCheckpoint } from "./checkpoint.ts";
import type { EvidenceCheckpoint } from "@openwork/freestyle/checkpoint-schema";

export interface ScreenshotArtifact {
  png: Buffer;
  hash: string;
  route: string;
  visibleText: string;
  at: string;
  checkpoint?: EvidenceCheckpoint;
  checkpointError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function screenshot(app: Surface, options?: { caption?: string; checkpoint?: boolean }): Promise<ScreenshotArtifact> {
  const at = new Date().toISOString();
  const png = await captureScreenshot(app.client);
  const page = await evaluate(app.client, () => (({
    route: window.location.hash,
    visibleText: document.body.innerText,
  })));
  if (!isRecord(page) || typeof page.route !== "string" || typeof page.visibleText !== "string") {
    throw new Error("CDP did not return the current route and visible text for the screenshot.");
  }
  const screenshotArtifact: ScreenshotArtifact = {
    png,
    hash: createHash("sha256").update(png).digest("hex"),
    route: page.route,
    visibleText: page.visibleText,
    at,
  };
  try {
    if (options?.checkpoint !== false) {
      screenshotArtifact.checkpoint = await captureScreenshotCheckpoint(app, { imageHash: screenshotArtifact.hash, capturedAt: at });
    }
  } catch {
    screenshotArtifact.checkpointError = "Checkpoint capture failed; screenshot retained.";
    currentTestEvidence()?.recordScreenshot(screenshotArtifact, options);
    currentTestEvidence()?.recordAssertionEvidence("Screenshot checkpoint captured", screenshotArtifact.checkpointError, false);
    throw new Error(screenshotArtifact.checkpointError);
  }
  currentTestEvidence()?.recordScreenshot(screenshotArtifact, options);
  return screenshotArtifact;
}
