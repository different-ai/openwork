import { browserScript, connect, debuggerUrlFor, listTargets } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

// Signed-in desktops no longer offer OpenCode Zen, so the app's built-in
// default model is unavailable and no chat can start. These journeys never
// send a turn; a fixture model only has to be selectable.
const FIXTURE_MODEL = { providerId: "feature-desktop-fixture", modelId: "feature-desktop-model" };

/**
 * The first chat. On CI the desktop can still be settling its workspace when the
 * control rail first offers "create task", and creation then returns nothing.
 * Give it a few more chances, and name what the desktop shows if it never works.
 */
async function firstSession(seed: Seed, app: Awaited<ReturnType<Seed["desktop"]>>, title: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await seed.session(app, { title });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < 4 && /did not return a session ID|returned no session ID/i.test(message)) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      const visible = await seed.evalIn(app, () => document.body.innerText.replace(/\s+/g, " ").slice(0, 800)).catch(() => "unavailable");
      throw new Error(`${message} The desktop showed: ${JSON.stringify(visible)}`);
    }
  }
}

/** A signed-in desktop with a fixture model selected and one chat on screen. */
export async function featureDesktop(seed: Seed, name: string, title: string) {
  const den = await seed.den({ org: { name: "Desktop features studio", admin: { name: "Workspace Owner" } }, mocks: { model: seed.mock({}) } });
  const model = den.mocks.model;
  if (!model) throw new Error("seed.den() did not boot the fixture model.");
  const organizationId = await seededOrganizationId(seed, den.admin);
  const { providerId, modelId } = FIXTURE_MODEL;
  const app = await seed.desktop({ name, den, as: "admin", model: `${providerId}/${modelId}` });
  const workspace = await seed.workspace(app, seed.tmpPath(name));
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Feature desktop fixture",
        options: { baseURL: `${model.url}/v1`, apiKey: "feature-desktop-fixture-only" },
        models: { [modelId]: { name: "Feature desktop model" } },
      },
    },
  });
  const session = await firstSession(seed, app, title);
  const platform = await seed.evalIn(app, () => navigator.platform);
  const snapshot = () => seed.evalIn(app, browserScript((sessionId: string) => window.__OPENWORK_ELECTRON__.invokeDesktop("computerSnapshot", sessionId), [session.sessionId]), { awaitPromise: true });
  return { den, organizationId, app, session, platform, snapshot };
}

/** The floating browser presentation, with a page origin the built-in browser can always reach. */
export async function browserFloatingViewWorld(seed: Seed) {
  const world = await featureDesktop(seed, "browser-floating-view", "Comparing release notes");
  // The embedded OpenWork server answers any path, so the page is local and deterministic.
  const info = await seed.evalIn(world.app, () => window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo"), { awaitPromise: true });
  if (!info || typeof info !== "object" || !("baseUrl" in info) || typeof info.baseUrl !== "string" || !info.baseUrl) {
    throw new Error("The embedded OpenWork server is unavailable.");
  }
  const origin = info.baseUrl.replace(/\/+$/, "");
  // The browser's own window is a second page target of the same app, titled
  // after its page. Attach to it to act inside it.
  const floatingTargets = async () => (await listTargets(world.app.handle.cdpUrl))
    .filter((target) => target.type === "page" && target.url === "about:blank" && target.title.endsWith("· Browser"));
  const floatingWindow = async (timeoutMs = 15_000): Promise<Surface> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const [target] = await floatingTargets();
      if (target) {
        const client = await connect(debuggerUrlFor(world.app.handle.cdpUrl, target));
        return { handle: world.app.handle, client };
      }
      if (Date.now() > deadline) throw new Error("The browser window did not open.");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const floatingWindowOpen = async () => (await floatingTargets()).length > 0;
  // What the person does to the window itself: drag its edge, or press its close button.
  const resizeWindow = (surface: Surface, width: number, height: number) => seed.evalIn(surface, browserScript((w: number, h: number) => window.resizeTo(w, h), [width, height]));
  const closeWindow = (surface: Surface) => seed.evalIn(surface, () => window.close());
  const windowFrame = (surface: Surface = world.app) => seed.evalIn(surface, () => ({
    inner: [window.innerWidth, window.innerHeight], outer: [window.outerWidth, window.outerHeight],
  }));
  const appFullscreen = () => seed.evalIn(world.app, () => document.fullscreenElement === document.documentElement);
  return { ...world, origin, floatingWindow, floatingWindowOpen, resizeWindow, closeWindow, windowFrame, appFullscreen, pageUrl: `${origin}/?floating-browser=release-notes` };
}

/** Computer use on this Mac. Readiness comes from the real helper and macOS permissions; nothing is faked. */
/** Computer use with the floating browser also on, as people who try both see the chat header. */
export async function computerUseWorld(seed: Seed) {
  return featureDesktop(seed, "computer-use-consent", "Tidy the project folder");
}
