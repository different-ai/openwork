import { createHash } from "node:crypto";
import { captureScreenshot, evaluate } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { currentTape } from "./ambient.ts";

export interface Shot {
  png: Buffer;
  hash: string;
  route: string;
  visibleText: string;
  at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function screenshot(app: Surface): Promise<Shot> {
  const at = new Date().toISOString();
  const png = await captureScreenshot(app.client);
  const page = await evaluate(app.client, `({
    route: window.location.hash,
    visibleText: document.body.innerText,
  })`);
  if (!isRecord(page) || typeof page.route !== "string" || typeof page.visibleText !== "string") {
    throw new Error("CDP did not return the current route and visible text for the screenshot.");
  }
  const shot: Shot = {
    png,
    hash: createHash("sha256").update(png).digest("hex"),
    route: page.route,
    visibleText: page.visibleText,
    at,
  };
  currentTape()?.recordTake(shot);
  return shot;
}
