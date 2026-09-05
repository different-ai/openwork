import { evaluate } from "./cdp.ts";
import type { Surface } from "./surface.ts";

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export async function setViewport(surface: Surface, viewport: Viewport): Promise<void> {
  await surface.client.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: false,
  });
}

export async function emulateFocus(surface: Surface): Promise<void> {
  await surface.client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
}

export async function paintBackdrop(surface: Surface, color: string): Promise<void> {
  await evaluate(surface.client, `(() => {
    if (!document.getElementById("docs-shots-backdrop")) {
      const style = document.createElement("style");
      style.id = "docs-shots-backdrop";
      style.textContent = "html { background-color: ${color} !important; }";
      document.head.appendChild(style);
    }
    return true;
  })()`);
}

/** Stop CSS motion and text carets so two clean frames can be pixel-identical. */
export async function freezeMotion(surface: Surface): Promise<void> {
  await evaluate(surface.client, `(() => {
    if (!document.getElementById("docs-shots-freeze")) {
      const style = document.createElement("style");
      style.id = "docs-shots-freeze";
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }";
      document.head.appendChild(style);
    }
    return true;
  })()`);
}
