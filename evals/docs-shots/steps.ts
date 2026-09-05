import { setTimeout as delay } from "node:timers/promises";
import { fill } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { inPage } from "./inpage.ts";

export type Step<T extends Surface = Surface> = (surface: T) => Promise<void>;

/** Close an open dialog or popover so shots remain order-independent. */
export async function dismissOverlays(surface: Surface): Promise<void> {
  for (const type of ["keyDown", "keyUp"] as const) {
    await surface.client.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  }
}

async function waitForText(surface: Surface, text: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await inPage(surface, `(args) => document.body.innerText.includes(args.text)`, { text }, { timeoutMs: 8_000 })
      .catch(() => false);
    if (found === true) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(text)}.`);
}

/** Keep a disclosure expanded until its proof text survives two checks. */
export function keepExpanded(label: string, proofText: string): Step {
  return async (surface) => {
    await waitForText(surface, label, 120_000);
    const deadline = Date.now() + 60_000;
    let stableChecks = 0;
    while (Date.now() < deadline) {
      const expanded = await inPage(surface, `(args) => {
        if (document.body.innerText.includes(args.proofText)) return true;
        const toggle = [...document.querySelectorAll("button")]
          .find((button) => (button.textContent ?? "").includes(args.label));
        if (toggle) toggle.click();
        return document.body.innerText.includes(args.proofText);
      }`, { label, proofText }, { timeoutMs: 8_000 }).catch(() => false);
      if (expanded === true) {
        stableChecks += 1;
        if (stableChecks >= 2) return;
      } else {
        stableChecks = 0;
      }
      await delay(1_000);
    }
    throw new Error(`${label} did not stay expanded.`);
  };
}

/** Fill a selector-to-value map in declaration order. */
export function fillForm(fields: Readonly<Record<string, string>>): Step {
  return async (surface) => {
    for (const [selector, value] of Object.entries(fields)) {
      await fill(surface, selector, value, { timeoutMs: 60_000 });
    }
  };
}
