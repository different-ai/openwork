import { control } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { configureBrowserFixtureModel, startBrowserFixture } from "@openwork/env";
import type { Den, Seed } from "@openwork/env";
import { attachBuiltinTab, browserTabHandle, builtinBrowserWorld } from "./browser-panel.ts";

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** The body gets resources, never closures retaining the setup Seed. */
export async function browserBackgroundWorld(seed: Seed) {
  const base = await builtinBrowserWorld(seed);
  const fixture = await startBrowserFixture(base.app, { requireSignIn: false });
  return { ...base, origin: fixture.origin, async [Symbol.asyncDispose]() { await fixture[Symbol.asyncDispose](); } };
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
    await seed.evalIn(base.app, `async function (disposePath) {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo');
      const response = await fetch(info.baseUrl + disposePath, {
        method: 'POST', headers: { Authorization: 'Bearer ' + info.clientToken },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error('Fixture model reload failed');
    }`, { args: [{ value: `${enginePath}/instance/dispose` }], awaitPromise: true, timeoutMs: 35_000 });
    const tab = browserTabHandle(await control(base.app, "browser.open_url", { url: `${origin}/`, provider: "builtin" }));
    const site = stack.use(await attachBuiltinTab(base.app, tab.targetId));
    return { ...base, origin, enginePath, tab, site, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
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
  await seed.evalIn(app, `window.dispatchEvent(new Event('openwork-den-settings-changed'))`);
}

export async function setBrowserEnabled(seed: Seed, app: Surface, enabled: boolean) {
  await seed.evalIn(app, `window.__OPENWORK_ELECTRON__.browser.setControlEnabled(${JSON.stringify(enabled)})`, { awaitPromise: true });
}
