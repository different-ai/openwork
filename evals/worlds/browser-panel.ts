import { connect, debuggerUrlFor, evaluate, listTargets } from "@openwork/cdp";
import type { CdpClient, Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";

export interface BuiltinBrowserTab {
  tabId: string;
  targetId: string;
  /** Distinguishes this tab's URL, and so its label in the side panel tab strip. */
  name: string;
}

export interface Viewport {
  width: number;
  height: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a non-empty string from the desktop bridge.");
  return value;
}

/**
 * A page origin the app can always reach from its own host: the embedded
 * OpenWork server. Any HTTP response renders as a page in the built-in
 * browser; the response body is irrelevant to the viewport journey.
 */
async function embeddedServerUrl(seed: Seed, app: Surface): Promise<string> {
  const info = await seed.evalIn(app, `window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo")`, { awaitPromise: true });
  if (!isRecord(info) || info.running !== true) throw new Error("The embedded OpenWork server is not running.");
  return stringField(info.baseUrl).replace(/\/+$/, "");
}

async function withTabClient<T>(app: Surface, targetId: string, run: (client: CdpClient) => Promise<T>): Promise<T> {
  const target = (await listTargets(app.handle.cdpUrl)).find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`Built-in browser tab target ${targetId} is not listed by the app's CDP endpoint.`);
  const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

function parseViewport(value: unknown): Viewport {
  if (!isRecord(value) || typeof value.width !== "number" || typeof value.height !== "number") {
    throw new Error("The built-in browser tab did not report a viewport.");
  }
  return { width: value.width, height: value.height };
}

/**
 * A desktop with one session open, so the built-in browser side panel has a
 * home, plus helpers that play an automation client against its tabs.
 */
export async function builtinBrowserWorld(seed: Seed) {
  const app = await seed.desktop({ name: "builtin-browser" });
  const workspace = await seed.workspace(app, seed.tmpPath("builtin-browser"));
  const session = await seed.session(app);
  const origin = await embeddedServerUrl(seed, app);

  return {
    app,
    workspace,
    session,

    /** Open a page in the built-in browser the way the agent's browser tool does. */
    async openTab(name: string): Promise<BuiltinBrowserTab> {
      const url = `${origin}/?viewport-probe=${encodeURIComponent(name)}`;
      const result = await seed.evalIn(
        app,
        `window.__OPENWORK_ELECTRON__.browser.openUrl(${JSON.stringify(url)})`,
        { awaitPromise: true, timeoutMs: 30_000 },
      );
      if (!isRecord(result)) throw new Error("browser.openUrl returned no handle.");
      return {
        tabId: stringField(result.tab_id),
        targetId: stringField(result.target_id),
        name,
      };
    },

    /**
     * What a screenshot or docs-shots client does: attach over CDP, emulate a
     * capture viewport, and disconnect without restoring it.
     */
    async leaveViewportEmulation(tab: BuiltinBrowserTab, viewport: Viewport): Promise<void> {
      await withTabClient(app, tab.targetId, async (client) => {
        await client.send("Emulation.setDeviceMetricsOverride", {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: 0,
          mobile: false,
        });
      });
    },

    /** The viewport the page inside a tab is laying out for right now. */
    async readViewport(tab: BuiltinBrowserTab): Promise<Viewport> {
      return withTabClient(app, tab.targetId, async (client) => parseViewport(
        await evaluate(client, "({ width: window.innerWidth, height: window.innerHeight })"),
      ));
    },
  };
}
