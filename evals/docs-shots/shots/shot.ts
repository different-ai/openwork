import { setTimeout as delay } from "node:timers/promises";
import type { Surface } from "@openwork/cdp";
import type { Ctx, Provider } from "../ctx.ts";
import { gate } from "../gate.ts";
import type { Gate } from "../gate.ts";
import { inPage } from "../inpage.ts";
import type { ShotSurface } from "../surfaces.ts";

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1440, height: 900, deviceScaleFactor: 2 };

export interface Shot {
  id: string;
  out: string;
  viewport?: Viewport;
  run: (ctx: Ctx) => Promise<Surface>;
  gate: Gate;
}

export type ShotStep<T extends ShotSurface> = (surface: T) => Promise<void>;

export interface ShotOptions<T extends ShotSurface> {
  use: Provider<T>;
  at: string | ((surface: T) => string);
  steps?: readonly ShotStep<T>[];
  expect: readonly string[];
  never?: readonly string[];
  out: string;
  route?: RegExp;
  viewport?: Viewport;
}

async function waitForExpectedText(surface: Surface, expect: readonly string[]): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ready = await inPage(surface, `(args) => args.expect.every((text) => document.body.innerText.includes(text))`, {
      expect,
    }, { timeoutMs: 8_000 }).catch(() => false);
    if (ready === true) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for shot text: ${expect.map((text) => JSON.stringify(text)).join(", ")}.`);
}

export function shot<T extends ShotSurface>(id: string, options: ShotOptions<T>): Shot {
  return {
    id,
    out: options.out,
    viewport: options.viewport,
    gate: gate({ expect: options.expect, never: options.never, route: options.route }),
    run: async (ctx) => {
      const surface = await ctx.use(options.use);
      const path = typeof options.at === "function" ? options.at(surface) : options.at;
      await surface.open(path);
      for (const step of options.steps ?? []) await step(surface);
      await waitForExpectedText(surface, options.expect);
      return surface;
    },
  };
}
