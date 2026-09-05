import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { resolvePlace } from "@openwork/testkit/stack";
import type { Den, Place } from "@openwork/testkit/stack";
import {
  ACME_DOCS_APP,
  ACME_DOCS_MEMBER,
  ACME_DOCS_ORGANIZATION_NAME,
  ACME_DOCS_PROMPT_CARDS,
  bootAcmeDocs,
} from "../../worlds/acme-docs.ts";
import type { AcmeDocsWorld } from "../../worlds/acme-docs.ts";
import { provider } from "./ctx.ts";

export const DOCS_ORGANIZATION_NAME = ACME_DOCS_ORGANIZATION_NAME;
export const DOCS_PROMPT_CARDS = ACME_DOCS_PROMPT_CARDS;
export const DOCS_MEMBER = ACME_DOCS_MEMBER;
export const DOCS_APP = ACME_DOCS_APP;

export interface SeededOrg {
  world: AcmeDocsWorld;
  den: Den;
  place: Place;
  orgId: string;
  /** Plugin ids in the order of the fixture's plugins. */
  pluginIds: string[];
  mcpToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOrganizationId(admin: DenSession): Promise<string> {
  const { response, body, text } = await denFetch(admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  const orgs = isRecord(body) && Array.isArray(body.orgs) ? body.orgs.filter(isRecord) : [];
  const organization = orgs.find((entry) => entry.name === DOCS_ORGANIZATION_NAME);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!response.ok || !id) throw new Error(`Resolving the organization failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  return id;
}

async function mintMcpToken(admin: DenSession, orgId: string): Promise<string> {
  const { response, body, text } = await denFetch(admin, "/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${admin.token}`, "x-openwork-org-id": orgId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = isRecord(body) && typeof body.token === "string" ? body.token : "";
  if (!response.ok || !token) throw new Error(`Minting an MCP token failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  return token;
}

export const org = provider(async (ctx) => {
  const place = resolvePlace(process.env);
  const stack = new AsyncDisposableStack();
  try {
    const world = await bootAcmeDocs(stack, place);
    ctx.onDispose(() => stack.disposeAsync());
    const orgId = await readOrganizationId(world.den.admin);
    return {
      world,
      den: world.den,
      place,
      orgId,
      pluginIds: world.pluginIds,
      mcpToken: await mintMcpToken(world.den.admin, orgId),
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
});
