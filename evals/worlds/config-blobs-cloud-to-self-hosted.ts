import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(value: unknown, ...path: string[]): unknown {
  let node = value;
  for (const key of path) node = isRecord(node) ? node[key] : undefined;
  return node;
}

function id(value: unknown, ...path: string[]): string {
  const found = pick(value, ...path);
  if (typeof found !== "string" || !found) throw new Error(`Missing ${path.join(".")} in ${JSON.stringify(value).slice(0, 300)}`);
  return found;
}

/** The provider key the owner typed on OpenWork Cloud. It must never be in an export. */
export const BYOK_API_KEY = "sk-acme-cloud-SECRET-7c41";
const NO_EMAIL_PROVIDER = { RESEND_API_KEY: "", SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", SMTP_PORT: "", SMTP_SECURE: "", EMAIL_FROM: "" };
const skillMarkdown = (name: string, body: string) => `---\nname: ${name}\ndescription: Summarize research sources before answering.\n---\n\n${body}\n`;

/**
 * Two Dens on two databases, so two different instance ids: one booted as
 * OpenWork Cloud (DEN_DEPLOYMENT=cloud, API only) holding a configured
 * organization, one booted as a self-hosted install (DEN_DEPLOYMENT=self_hosted,
 * with Den web) holding the same owner's empty organization. Everything in the
 * cloud organization is created through the same public API the dashboard uses.
 */
export async function configBlobsCloudToSelfHostedWorld(seed: Seed) {
  const stamp = Date.now().toString(36);
  const owner = { email: `avery+${stamp}@acme-robotics.test`, name: "Avery Owner", password: "OpenWorkEval123!" };
  const cloud = await seed.den({
    web: false,
    env: { DEN_DEPLOYMENT: "cloud", ...NO_EMAIL_PROVIDER },
    org: {
      name: "Acme Robotics",
      admin: owner,
      members: {
        jordan: { email: `jordan+${stamp}@acme-robotics.test`, name: "Jordan Lee" },
        sam: { email: `sam+${stamp}@acme-robotics.test`, name: "Sam Park" },
      },
    },
    mocks: { docs: seed.mock({ allowUnauthenticatedMcp: true }) },
  });
  const selfHosted = await seed.den({
    env: { DEN_DEPLOYMENT: "self_hosted", ...NO_EMAIL_PROVIDER },
    org: {
      name: "Acme Robotics",
      admin: owner,
      members: { riley: { email: `riley+${stamp}@acme-robotics.test`, name: "Riley Member" } },
    },
  });
  const cloudOrgId = await enableOrganizationCapabilities(seed, cloud.admin, { configBlobs: true });
  const selfHostedOrgId = await enableOrganizationCapabilities(seed, selfHosted.admin, { configBlobs: true });

  const call = async (session: DenSession, path: string, body: unknown, method = "POST") => {
    const result = await seed.api(session, path, { method, body: JSON.stringify(body) });
    if (!result.response.ok) throw new Error(`${method} ${path}: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
    return result.body;
  };
  const memberId = async (session: DenSession) => id((await seed.api(session, "/v1/org")).body, "currentMember", "id");
  const admin = cloud.admin;
  const jordan = cloud.members.jordan, sam = cloud.members.sam;
  if (!jordan || !sam) throw new Error("Cloud members were not provisioned");
  const [jordanId, samId] = [await memberId(jordan), await memberId(sam)];

  // Members: two teams, a role, an invitation still pending.
  const platform = id(await call(admin, "/v1/teams", { name: "Platform", memberIds: [jordanId] }), "team", "id");
  const research = id(await call(admin, "/v1/teams", { name: "Research", memberIds: [samId] }), "team", "id");
  const invitedEmail = `casey+${stamp}@acme-robotics.test`;
  await call(admin, "/v1/invitations", { email: invitedEmail, role: "member", teamId: platform });
  await call(admin, "/v1/permissions/sets", { name: "Viewers", teamIds: [research], permissions: [{ key: "teams.view", status: "allow" }] });
  // AI: a BYOK provider with its API key, the default model and a prompt for everyone.
  const byok = await call(admin, "/v1/llm-providers", {
    name: "Acme LLM",
    source: "custom",
    customConfig: { id: "acme", name: "Acme", npm: "@ai-sdk/openai-compatible", env: ["ACME_API_KEY"], api: "https://llm.acme-robotics.test/v1", models: [{ id: "acme-1", name: "Acme One" }, { id: "acme-2", name: "Acme Two" }] },
    apiKey: BYOK_API_KEY,
    teamIds: [platform, research],
  });
  const byokId = id(byok, "llmProvider", "id");
  await call(admin, "/v1/org/default-model/everyone", { model: { providerId: byokId, modelId: "acme-1" } }, "PUT");
  await call(admin, "/v1/org/prompts/everyone", { content: "Be concise. Cite the source file." }, "PUT");
  // Connectors and policy: a no-auth MCP server for Platform, a desktop policy.
  await call(admin, "/v1/mcp-connections", { name: "Docs MCP", url: cloud.mocks.docs?.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: false, teamIds: [platform], memberIds: [] } });
  await call(admin, "/v1/desktop-policies", { policyName: "Engineering laptops", policy: { execution: { commands: "allow", blockedCommands: ["rm -rf /"] } }, priority: 5, teamIds: [platform], memberIds: [], roles: [] });
  // Settings: a web origin and the brand.
  await call(admin, "/v1/org/web-origins", { origin: "https://work.acme-robotics.test" });
  await call(admin, "/v1/org", { brandAppName: "Acme Work" }, "PATCH");
  // Plugins: a plugin with one skill, shared with Research.
  const pluginId = id(await call(admin, "/v1/plugins", { name: "Research kit", description: "Helpers for the research team" }), "item", "id");
  await call(admin, `/v1/plugins/${pluginId}/access`, { teamId: research, role: "viewer" });
  await call(admin, "/v1/config-objects", { type: "skill", sourceMode: "cloud", pluginIds: [pluginId], input: { rawSourceText: skillMarkdown("summarize-sources", "Read every source first, then summarize.") } });

  const viewport = { width: 1280, height: 900, deviceScaleFactor: 1 };
  const ownerWeb = await seed.web({ den: selfHosted, signedInAs: selfHosted.admin, startPath: "/dashboard/config", headless: true, viewport });
  const riley = selfHosted.members.riley;
  if (!riley) throw new Error("Self-hosted member was not provisioned");
  const memberWeb = await seed.web({ den: selfHosted, signedInAs: riley, startPath: "/dashboard", headless: true, viewport });

  // A standard (non-config) API key, as an owner would make one for a script.
  const created = await call(selfHosted.admin, "/v1/api-keys", { name: "Deploy script" });
  const standardKey = id(created, "key");

  const exportPath = seed.tmpPath(`openwork-config-acme-robotics-${stamp}.json`);

  /** GET as a person signed in to one of the Dens; reads only. */
  const read = async (session: DenSession, path: string) => {
    const result = await seed.api(session, path);
    return { status: result.response.status, body: result.body, text: result.text };
  };

  return {
    cloud,
    selfHosted,
    cloudOrgId,
    selfHostedOrgId,
    owner,
    invitedEmail,
    byokId,
    ownerWeb,
    memberWeb,
    riley,
    exportPath,
    read,
    url: (path: string) => new URL(path, selfHosted.ref.webUrl).toString(),
    /** The owner downloads the whole organization from OpenWork Cloud, as Settings › Config › Download does, and saves the file. */
    async exportFromCloud() {
      const result = await read(cloud.admin, "/v1/config-blobs/export");
      if (result.status !== 200) throw new Error(`Cloud export: HTTP ${result.status} ${result.text.slice(0, 300)}`);
      await mkdir(dirname(exportPath), { recursive: true });
      await writeFile(exportPath, result.text);
      return result;
    },
    /** What a member's browser sends when it tries to approve a change request. */
    async approveAs(session: DenSession, changeRequestId: string, planHash: string) {
      const result = await seed.api(session, `/v1/config-blobs/change-requests/${changeRequestId}/approve`, { method: "POST", body: JSON.stringify({ planHash }) });
      return { status: result.response.status, body: result.body };
    },
    /** What a script holding the standard API key sends. */
    async withStandardKey(method: "GET" | "POST", path: string, body?: unknown) {
      const response = await fetch(`${selfHosted.ref.apiUrl}${path}`, {
        method,
        headers: { "x-api-key": standardKey, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, body: parsed };
    },
  };
}
