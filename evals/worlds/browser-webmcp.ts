import { browserScript, evaluate } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { configureBrowserFixtureModel, startBrowserFixture } from "@openwork/env";
import type { Den, Seed } from "@openwork/env";
import { builtinBrowserWorld } from "./browser-panel.ts";

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** The body gets resources, never closures retaining the setup Seed. */
export async function browserBackgroundWorld(seed: Seed) {
  const base = await builtinBrowserWorld(seed);
  const fixture = await startBrowserFixture(base.app, { requireSignIn: false });
  return {
    ...base,
    origin: fixture.origin,
    /**
     * A command stamped with the conversation it comes from, exactly as the
     * server hands mailbox requests to the window. The HTTP mailbox itself
     * answers "did not answer within 5 seconds", so a command that must wait
     * for the user's approval is issued at the window boundary.
     */
    async commandFrom(sessionId: string, id: string, args: Record<string, unknown>): Promise<unknown> {
      return evaluate(base.app.client, browserScript((id, encodedArgs, sessionId) =>
        window.__openworkControl.command({ id, args: JSON.parse(encodedArgs), origin: { sessionId } }),
      [id, JSON.stringify(args), sessionId]), { awaitPromise: true, timeoutMs: 120_000 });
    },
    async [Symbol.asyncDispose]() { await fixture[Symbol.asyncDispose](); },
  };
}

export async function browserWebMcpWorld(seed: Seed) {
  const workspacePath = seed.tmpPath("browser-tools");
  const base = await builtinBrowserWorld(seed, { workspacePath });
  const stack = new AsyncDisposableStack();
  try {
    const fixture = stack.use(await startBrowserFixture(base.app));
    const origin = fixture.origin;
    await configureBrowserFixtureModel(base.app, workspacePath, origin);
    const enginePath = `/workspace/${base.workspace.workspaceId}/opencode`;
    await seed.evalIn(base.app, browserScript(async (disposePath) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo');
      const response = await fetch(info.baseUrl + disposePath, {
        method: 'POST', headers: { Authorization: 'Bearer ' + info.clientToken },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error('Fixture model reload failed');
    }, [`${enginePath}/instance/dispose`]), { awaitPromise: true, timeoutMs: 35_000 });
    // Leave the browser unmounted: the discovery turn must request its first tab.
    return { ...base, origin, enginePath, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
  } catch (error) { await stack.disposeAsync(); throw error; }
}

/** Mid-flow fixture update uses the body's Seed and preserves every unrelated policy field. */
export async function setBrowserPolicy(seed: Seed, app: Surface, den: Den, origins: string[] | null, blockBrowserUploads = false) {
  const listed = await seed.api(den.admin, "/v1/desktop-policies");
  if (!listed.response.ok || !record(listed.body) || !Array.isArray(listed.body.desktopPolicies)) throw new Error("No organization policies.");
  const current = listed.body.desktopPolicies.find((item: unknown) => record(item) && item.isDefault === true);
  if (!record(current) || typeof current.id !== "string" || !record(current.policy)) throw new Error("Missing default policy.");
  const execution = { ...(record(current.policy.execution) ? current.policy.execution : {}), blockBrowserUploads };
  const policy = { ...current.policy, execution: { ...execution, ...(origins === null ? {} : { browserOrigins: origins }) } };
  if (origins === null) Reflect.deleteProperty(policy.execution, "browserOrigins");
  const patched = await seed.api(den.admin, `/v1/desktop-policies/${current.id}`, {
    method: "PATCH", body: JSON.stringify({ policyName: current.policyName, policy }),
  });
  if (!patched.response.ok) throw new Error("The organization rejected its browser policy update.");
  await seed.evalIn(app, () => window.dispatchEvent(new Event('openwork-den-settings-changed')));
}

export async function setBrowserEnabled(seed: Seed, app: Surface, enabled: boolean) {
  await seed.evalIn(app, browserScript((enabled) => window.__OPENWORK_ELECTRON__.browser.setControlEnabled(enabled), [enabled]), { awaitPromise: true });
}
