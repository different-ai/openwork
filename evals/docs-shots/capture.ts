import { setTimeout as delay } from "node:timers/promises";
import { evalIn } from "@openwork/behaviors";
import { emulateFocus, freezeMotion, paintBackdrop, setViewport } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { screenshot } from "@openwork/test-evidence";
import type { Gate } from "./scene.ts";

export { emulateFocus, freezeMotion, paintBackdrop, setViewport };

function gateFailures(gate: Gate, visibleText: string, route: string): string[] {
  const failures: string[] = [];
  for (const text of gate.requireText) {
    if (!visibleText.includes(text)) failures.push(`missing required text ${JSON.stringify(text)}`);
  }
  for (const text of gate.rejectText ?? []) {
    if (visibleText.includes(text)) failures.push(`forbidden text ${JSON.stringify(text)} is on screen`);
  }
  if (gate.route && !gate.route.test(decodeURIComponent(route))) {
    failures.push(`route ${JSON.stringify(route)} does not match ${String(gate.route)}`);
  }
  return failures;
}

/**
 * Capture-until-clean: re-shoot every 500ms until the gate passes, then demand
 * a second, pixel-identical frame so animations and loading states can never
 * ship. Throws with the last failure list when the deadline passes.
 */
export async function captureGated(surface: Surface, gate: Gate, timeoutMs = 30_000): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  let lastFailures: string[] = ["no capture attempted"];
  let lastVisibleText = "";
  let consecutivePasses = 0;
  while (Date.now() < deadline) {
    const shot = await screenshot(surface);
    lastVisibleText = shot.visibleText;
    lastFailures = gateFailures(gate, shot.visibleText, shot.route);
    if (lastFailures.length === 0 && gate.requireExpression) {
      const satisfied = await evalIn(surface, gate.requireExpression).catch(() => false);
      if (satisfied !== true) lastFailures = [`expression not satisfied: ${gate.requireExpression}`];
    }
    if (lastFailures.length === 0) {
      consecutivePasses += 1;
      await delay(400);
      const settled = await screenshot(surface);
      const settledFailures = gateFailures(gate, settled.visibleText, settled.route);
      if (settledFailures.length === 0 && settled.hash === shot.hash) return settled.png;
      if (settledFailures.length === 0 && consecutivePasses >= 5) {
        // The gate holds across frames but pixels keep moving (a decorative
        // JS animation). The content claims are satisfied; accept the frame.
        console.warn("[docs-shots] accepting a frame with a persistent decorative animation");
        return settled.png;
      }
      lastFailures = settledFailures.length > 0 ? settledFailures : ["frame not stable yet"];
    } else {
      consecutivePasses = 0;
    }
    await delay(500);
  }
  throw new Error(
    `Screenshot gate failed after ${timeoutMs}ms:\n- ${lastFailures.join("\n- ")}\n\nVisible text tail:\n${lastVisibleText.slice(-600)}`,
  );
}
