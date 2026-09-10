import { allocateFreePorts, connect, debuggerUrlFor, listTargets } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { faultProxy as startFaultProxy, mcpMock } from "@openwork/env";
import type { MockHandle, Place, Seed } from "@openwork/env";

function windowId(response: unknown): number {
  if (typeof response !== "object" || response === null || !("windowId" in response) || typeof response.windowId !== "number") {
    throw new Error("Browser.getWindowForTarget did not return a window ID.");
  }
  return response.windowId;
}

/**
 * A member's browser talking to den-api through a proxy that can answer the
 * OAuth-start request with an error the browser is not allowed to read. The
 * proxy is fixed in front of den-api before Den boots so DEN_API_PUBLIC_URL
 * (which den-web hands to the browser as denApiUrl) points at it; the browser
 * page itself stays on Den's own web origin, which den-api's CORS allowlist
 * trusts, so every non-faulted request round-trips normally.
 *
 * The synthetic provider runs on a fixed port owned by this world so the spec
 * can take it away (den-api then fails the handshake itself) and bring it back.
 */
export async function oauthStartUnreadableWeb(seed: Seed, ctx: { place: Place }) {
  if (ctx.place.kind !== "local") throw new Error("This world fixes a local fault proxy in front of den-api before boot; run it on the local lane.");
  const [apiPort, webPort, providerPort] = await allocateFreePorts(3);
  const denApiUrl = `http://127.0.0.1:${apiPort}`;
  const proxy = await startFaultProxy({ apiUrl: denApiUrl, webUrl: denApiUrl }, { place: ctx.place });
  let provider: MockHandle = (await mcpMock({ port: providerPort }).boot(ctx.place)).handle;
  const den = await seed.den({
    ports: { api: apiPort, web: webPort },
    org: { name: `OAuth start readability ${Date.now()}`, admin: { name: "Connections Admin" } },
    env: { DEN_API_PUBLIC_URL: proxy.ref.webUrl },
  });
  const connection = await seed.orgConnection(den.admin, {
    name: "Synthetic calendar provider",
    url: provider.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard/your-connections",
    headless: true,
    viewport: { width: 1440, height: 1100 },
  });
  const denWebOrigin = new URL(den.ref.webUrl).origin;
  return Object.assign({
    den,
    proxy,
    connection,
    web,
    startPath: `/v1/mcp-connections/${connection.id}/connect/start`,
    /** Authorization requests the synthetic provider has received since it (re)started. */
    async authorizeRequests(): Promise<number> {
      return (await provider.requests()).filter((entry) => entry.path === "/authorize").length;
    },
    async stopProvider(): Promise<void> {
      await provider.stop();
    },
    /** The OpenWork sign-in tab opened by Connect, once the browser has created and navigated it (null after the wait). */
    async signInTab({ timeoutMs = 15_000 }: { timeoutMs?: number } = {}): Promise<Surface | null> {
      const startedAt = Date.now();
      while (true) {
        const target = (await listTargets(web.handle.cdpUrl)).find((entry) => (
          entry.type === "page"
          && entry.id !== web.client.targetId
          && entry.url.startsWith(`${denWebOrigin}/connect/oauth`)
        ));
        if (target) return { handle: web.handle, client: await connect(debuggerUrlFor(web.handle.cdpUrl, target)) };
        if (Date.now() - startedAt >= timeoutMs) return null;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    async pageTargetUrls(): Promise<string[]> {
      return (await listTargets(web.handle.cdpUrl))
        .filter((entry) => entry.type === "page")
        .map((entry) => entry.url);
    },
    async sameWindowAsDashboard(tab: Surface): Promise<boolean> {
      const dashboardTargetId = web.client.targetId;
      const tabTargetId = tab.client.targetId;
      if (!dashboardTargetId || !tabTargetId) throw new Error("Expected dashboard and sign-in tab target IDs.");
      const [dashboardWindow, tabWindow] = await Promise.all([
        web.client.send("Browser.getWindowForTarget", { targetId: dashboardTargetId }),
        web.client.send("Browser.getWindowForTarget", { targetId: tabTargetId }),
      ]);
      return windowId(dashboardWindow) === windowId(tabWindow);
    },
    async closeTab(tab: Surface): Promise<void> {
      const targetId = tab.client.targetId;
      if (!targetId) throw new Error("Expected a sign-in tab target ID.");
      await web.client.send("Target.closeTarget", { targetId });
      tab.client.close();
    },
    async restartProvider(options: { rejectDynamicRedirectUris?: "invalid_redirect_uri" | "invalid_request" } = {}): Promise<void> {
      await provider.stop();
      provider = (await mcpMock({ port: providerPort, ...options }).boot(ctx.place)).handle;
    },
  }, {
    async [Symbol.asyncDispose]() {
      await provider.stop();
      await proxy[Symbol.asyncDispose]();
    },
  });
}
