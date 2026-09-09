import { allocateFreePorts } from "@openwork/cdp";
import { faultProxy as startFaultProxy, mcpMock } from "@openwork/env";
import type { MockHandle, Place, Seed } from "@openwork/env";

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
    async restartProvider(): Promise<void> {
      provider = (await mcpMock({ port: providerPort }).boot(ctx.place)).handle;
    },
  }, {
    async [Symbol.asyncDispose]() {
      await provider.stop();
      await proxy[Symbol.asyncDispose]();
    },
  });
}
