import { setTimeout as delay } from "node:timers/promises";
import type { Surface } from "@openwork/cdp";
import { screenshot } from "@openwork/test-evidence";
import type { ScreenshotArtifact } from "@openwork/test-evidence";
import type { Gate } from "./gate.ts";

/** Wait for accepted content to hold across stable consecutive frames. */
export async function captureUntil(surface: Surface, accepts: Gate, timeoutMs = 30_000): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  let previous: ScreenshotArtifact | null = null;
  let consecutivePasses = 0;
  let lastVisibleText = "";
  while (Date.now() < deadline) {
    const frame = await screenshot(surface);
    lastVisibleText = frame.visibleText;
    if (accepts(frame)) {
      consecutivePasses += 1;
      if (previous?.hash === frame.hash) return frame.png;
      if (consecutivePasses >= 5) {
        console.warn("[docs-shots] accepting a frame with a persistent decorative animation");
        return frame.png;
      }
      previous = frame;
      await delay(400);
      continue;
    }
    previous = null;
    consecutivePasses = 0;
    await delay(500);
  }
  throw new Error(`Screenshot gate failed after ${timeoutMs}ms.\n\nVisible text tail:\n${lastVisibleText.slice(-600)}`);
}
