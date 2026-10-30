import { denFetch } from "@openwork/behaviors";
import { queryDenDatabase, type Seed } from "@openwork/env";
import { healthFixture } from "./den-service-readiness.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { chatAs } from "./workbot-agent-library.ts";
import { ENCRYPTION_KEY } from "./workbot-proactive.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Your agent's sources: Den with Workbot and Your agent on for one organization (My bot on too), a Google Workspace
 * connector the member hasn't signed in to, and three shared connections everyone can use without signing in. They
 * are created against a local MCP fixture, then pointed at Granola's, Linear's and Notion's MCP addresses: agents only
 * read services whose read tools are reviewed, recognised by that address. A fourth, "Support desk", stays on the
 * fixture: a service without reviewed reads, which can't be a source at all. Granola needs no sign-in, so once the
 * admin allows it for Email it is the app the member already has, and their agent reads email from it rather than asking
 * them to connect Google. Nothing contacts the reviewed services and no turn runs during the proof; "chat" is the
 * Connect call Workbot makes for the member.
 */
export async function workbotAgentSourcesWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const runner = stack.use(await healthFixture());
    const den = await seed.den({
      org: {
        name: "Agent sources",
        admin: { name: "Workspace Owner" },
        members: { member: { name: "Workspace Member" } },
      },
      mocks: { tools: seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true }) },
      env: {
        DEN_WORKBOT_URL: "http://localhost:3020",
        DEN_HEADLESS_RUNNER_URL: runner.url,
        DEN_HEADLESS_RUNNER_TOKEN: "readiness-fixture-service-token-not-production",
        DEN_DB_ENCRYPTION_KEY: ENCRYPTION_KEY,
      },
    });
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { workbotProactive: true, workbotAgentLibrary: true });
    const enabled = await seed.api(den.admin, "/v1/org/workbot-settings/proactive", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    if (!enabled.response.ok) throw new Error(`Turning on Your agent failed: ${enabled.text.slice(0, 300)}`);
    await seed.nativeConnector(den.admin, {
      providerKey: "google-workspace",
      name: "Google Workspace",
      clientId: "fixture-client.apps.googleusercontent.com",
      clientSecret: "fixture-secret",
      features: ["calendarRead", "gmailDraft", "driveRead"],
      access: { orgWide: true },
    });
    const databaseUrl = den.database?.url;
    if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("The sources world needs its own eval database.");
    const connect = async (name: string, serviceUrl: string) => {
      const created = await seed.orgConnection(den.admin, { name, url: den.mocks.tools.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } });
      await queryDenDatabase(databaseUrl, "UPDATE external_mcp_connection SET url = ? WHERE id = ?", [serviceUrl, created.id]);
      return created;
    };
    const notes = await connect("Granola", "https://mcp.granola.ai/mcp");
    const tracker = await connect("Linear", "https://mcp.linear.app/mcp");
    const wiki = await connect("Notion", "https://mcp.notion.com/mcp");
    const desk = await seed.orgConnection(den.admin, { name: "Support desk", url: den.mocks.tools.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } });

    const headers = { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": organizationId };
    const viewport = { width: 1280, height: 2200, deviceScaleFactor: 1 };
    const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard/my-bot", headless: true, viewport });
    return {
      den,
      owner,
      member,
      connections: { notes, tracker, wiki, desk },
      /** What the member says in chat, as Workbot passes it to Den. */
      sayInChat: (name: string, body?: unknown) => chatAs(den.members.member, organizationId, name, body),
      /** The organization's policy per source, as Manage › Workbot shows it. */
      async policy(): Promise<unknown> {
        const read = await denFetch(den.admin, "/v1/org/workbot-settings/proactive", { headers });
        return isRecord(read.body) && isRecord(read.body.settings) ? read.body.settings.sources : null;
      },
      async [Symbol.asyncDispose]() {
        await stack.disposeAsync();
      },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
