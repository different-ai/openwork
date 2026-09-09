import { allocateFreePorts } from "@openwork/cdp";
import { faultProxy as startFaultProxy, mcpMock } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";

/**
 * A member's browser talking to den-api through a proxy that can answer the
 * OAuth-start request with an error the browser is not allowed to read. The
 * proxy is fixed in front of den-api before Den boots so DEN_API_PUBLIC_URL
 * (which den-web hands to the browser as denApiUrl) points at it; the browser
 * page itself stays on Den's own web origin, which den-api's CORS allowlist
 * trusts, so every non-faulted request round-trips normally.
 */
export async function oauthStartUnreadableWeb(seed: Seed, ctx: { place: Place }) {
  if (ctx.place.kind !== "local") throw new Error("This world fixes a local fault proxy in front of den-api before boot; run it on the local lane.");
  const [apiPort, webPort] = await allocateFreePorts(2);
  const denApiUrl = `http://127.0.0.1:${apiPort}`;
  const proxy = await startFaultProxy({ apiUrl: denApiUrl, webUrl: denApiUrl }, { place: ctx.place });
  const den = await seed.den({
    ports: { api: apiPort, web: webPort },
    mocks: { connector: mcpMock() },
    org: { name: `OAuth start readability ${Date.now()}`, admin: { name: "Connections Admin" } },
    env: { DEN_API_PUBLIC_URL: proxy.ref.webUrl },
  });
  const connection = await seed.orgConnection(den.admin, {
    name: "Synthetic calendar provider",
    url: den.mocks.connector.mcpUrl,
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
  return Object.assign({ den, proxy, connection, web, startPath: `/v1/mcp-connections/${connection.id}/connect/start` }, {
    async [Symbol.asyncDispose]() {
      await proxy[Symbol.asyncDispose]();
    },
  });
}
