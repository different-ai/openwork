import { allocateFreePort, allocateFreePorts } from "@openwork/cdp";
import type { DenSession } from "@openwork/behaviors";
import { faultProxy as startFaultProxy } from "@openwork/env";
import type { MockHandle, Place, Seed } from "@openwork/env";
import { denSignInTab, mockTools } from "./den-library-manage.ts";
import { isRecord, records, stringField } from "./library.ts";

/**
 * One organization where Sam, a member, adds his vendor's MCP servers by their
 * address. Den checks every address for real against local mocks: Acme Desk
 * lets OpenWork register itself (DCR), Old Desk only takes a client an admin
 * registers, and one address has nothing behind it. A proxy in front of
 * den-api pins the catalog so the page looks the same on every run; no real
 * provider is contacted.
 */
export async function denMcpByAddress(seed: Seed, ctx: { place: Place }) {
  if (ctx.place.kind !== "local") throw new Error("This world fixes a local proxy in front of den-api before boot; run it on the local lane.");
  const [apiPort, webPort] = await allocateFreePorts(2);
  const denApiUrl = `http://127.0.0.1:${apiPort}`;
  const proxy = await startFaultProxy({ apiUrl: denApiUrl, webUrl: denApiUrl }, { place: ctx.place });
  const den = await seed.den({
    ports: { api: apiPort, web: webPort },
    org: {
      name: `MCP by address ${Date.now()}`,
      admin: { name: "Riley Admin" },
      members: { sam: { name: "Sam K." }, maya: { name: "Maya Chen" } },
    },
    env: { DEN_API_PUBLIC_URL: proxy.ref.webUrl },
    webApiBase: proxy.ref.webUrl,
    mocks: {
      acmeDesk: seed.mock({
        tools: mockTools([
          ["search_tickets", "Search support tickets"],
          ["read_ticket", "Read a ticket and every reply"],
          ["reply_to_ticket", "Reply to a ticket"],
        ]),
      }),
      oldDesk: seed.mock({ disableDcr: true }),
    },
  });
  await proxy.faults.status("/v1/mcp-connections/presets", 200, {
    times: 10_000,
    body: {
      presets: [
        { presetId: "slack", displayName: "Slack", description: "Messages and channels.", url: "https://slack.connector.test/mcp", authType: "oauth" },
        { presetId: "notion", displayName: "Notion", description: "Pages and databases.", url: "https://notion.connector.test/mcp", authType: "oauth" },
        { presetId: "linear", displayName: "Linear", description: "Issues and projects.", url: "https://linear.connector.test/mcp", authType: "oauth" },
      ],
    },
  });

  const { acmeDesk, oldDesk } = den.mocks;
  const nothingThere = `http://127.0.0.1:${await allocateFreePort()}/mcp`;
  const web = await seed.web({
    den,
    signedInAs: den.members.sam,
    startPath: "/dashboard/library/connectors/new",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });

  return Object.assign({
    den,
    web,
    acmeDesk,
    oldDesk,
    /** An address with nothing listening behind it, like a mistyped port. */
    nothingThere,
    /** Names in a person's My Library, straight from Den. */
    async library(session: DenSession): Promise<string[]> {
      const result = await seed.api(session, "/v1/me/library");
      if (!result.response.ok || !isRecord(result.body)) throw new Error(`Could not read the Library: HTTP ${result.response.status}`);
      return records(result.body.items).map((item) => stringField(item, "name"));
    },
    /** What a mock server was asked from outside the harness, as "METHOD /path status" lines. */
    async served(mock: MockHandle): Promise<string[]> {
      return (await mock.requests())
        .filter((request) => request.path !== "/health" && request.path !== "/requests" && !request.path.startsWith("/admin/"))
        .map((request) => `${request.method} ${request.path} ${request.status ?? "pending"}`);
    },
    /** True once the browser has been served the pinned catalog and Den's real discovery, never a pinned answer. */
    async checkedForReal(): Promise<boolean> {
      const log = await proxy.requestLog();
      const catalog = log.some((entry) => entry.path.startsWith("/v1/mcp-connections/presets") && entry.faulted);
      const discovery = log.filter((entry) => entry.path.startsWith("/v1/mcp-connections/discover"));
      return catalog && discovery.length > 0 && discovery.every((entry) => !entry.faulted);
    },
    signInTab: (options?: { timeoutMs?: number }) => denSignInTab(web, den.ref.webUrl, options),
  }, {
    async [Symbol.asyncDispose]() {
      await proxy[Symbol.asyncDispose]();
    },
  });
}
