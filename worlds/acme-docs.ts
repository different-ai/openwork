import { createOrgConnection, createPluginWithSkill, denFetch } from "../evals/packages/behaviors/src/index.ts";
import type { DenSession } from "../evals/packages/behaviors/src/index.ts";
import { app } from "../evals/packages/env/src/desktop-app.ts";
import type { App } from "../evals/packages/env/src/desktop-app.ts";
import { createAdmin, createOrg, inviteMember, server } from "../evals/packages/env/src/den.ts";
import type { Den, DenOrgHandle } from "../evals/packages/env/src/den.ts";
import { mcpMock } from "../evals/packages/env/src/mock.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";

export const ACME_DOCS_ORGANIZATION_NAME = "Acme Robotics";
export const ACME_DOCS_MEMBER = "jordan";
export const ACME_DOCS_APP = "docs";
export const ACME_DOCS_WORKSPACE = "/tmp/acme/acme-robotics";
export const ACME_DOCS_PROMPT_CARDS = [
  {
    title: "Prepare a customer briefing",
    prompt: "Review this workspace and prepare a briefing with customer goals, recent decisions, risks, and next steps.",
  },
  {
    title: "Turn meeting notes into action",
    prompt: "Turn the latest meeting notes into an action plan with owners, deadlines, dependencies, and open questions.",
  },
  {
    title: "Draft the weekly project update",
    prompt: "Summarize project progress, risks, decisions, and next week's priorities for the leadership team.",
  },
];

const plugins = [
  {
    name: "Customer Research",
    description: "Prepare for sales calls with a structured company brief.",
    skillName: "customer-research",
    skillDescription: "Research a company and summarize key facts before a sales call.",
    skillBody: "# Instructions\n\n1. Gather the company's product, size, and recent news.\n2. Summarize the three facts that matter for this call.\n3. Suggest one opening question.",
  },
  {
    name: "Weekly Status Report",
    description: "Draft the weekly status update from recent activity.",
    skillName: "weekly-status-report",
    skillDescription: "Draft the weekly status update from this week's activity.",
    skillBody: "# Instructions\n\n1. Collect what shipped, what slipped, and what is blocked.\n2. Write a five-line update in the team's usual format.",
  },
  {
    name: "Meeting Notes",
    description: "Turn a transcript into structured meeting notes.",
    skillName: "meeting-notes",
    skillDescription: "Turn a meeting transcript into decisions, owners, and follow-ups.",
    skillBody: "# Instructions\n\n1. Extract decisions, owners, and deadlines from the transcript.\n2. List open questions at the end.",
  },
];

export interface AcmeDocsWorld {
  den: Den;
  org: DenOrgHandle;
  docs: App;
  pluginIds: string[];
  app(name: string): App;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

async function memberId(session: DenSession, organizationId: string): Promise<string> {
  const route = "/v1/me/orgs";
  const result = await denFetch(session, route, { headers: auth(session) });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((candidate) => candidate.id === organizationId);
  const id = organization && typeof organization.membershipId === "string"
    ? organization.membershipId
    : organization && typeof organization.orgMemberId === "string"
      ? organization.orgMemberId
      : "";
  if (!result.response.ok || !id) {
    throw new Error(`GET ${route} could not resolve Jordan's organization member id: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function enableDocsCapabilities(admin: DenSession, organizationId: string): Promise<void> {
  const route = `/v1/admin/organizations/${organizationId}/capabilities`;
  const result = await denFetch(admin, route, {
    method: "PUT",
    headers: auth(admin),
    body: JSON.stringify({ capabilities: { mcpConnections: true, cloud: true } }),
  });
  if (!result.response.ok) {
    throw new Error(`PUT ${route} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

async function createProductOperationsPolicy(
  den: Den,
  organizationId: string,
  jordan: DenSession,
): Promise<void> {
  const jordanId = await memberId(jordan, organizationId);
  const teamRoute = "/v1/teams";
  const team = await denFetch(den.admin, teamRoute, {
    method: "POST",
    headers: { ...auth(den.admin), "x-openwork-org-id": organizationId },
    body: JSON.stringify({ name: "Product Operations", memberIds: [jordanId] }),
  });
  const teamRecord = isRecord(team.body) && isRecord(team.body.team) ? team.body.team : null;
  const teamId = teamRecord && typeof teamRecord.id === "string" ? teamRecord.id : "";
  if (team.response.status !== 201 || !teamId) {
    throw new Error(`POST ${teamRoute} failed: HTTP ${team.response.status} ${team.text.slice(0, 500)}`);
  }

  const policyRoute = "/v1/desktop-policies";
  const policy = await denFetch(den.admin, policyRoute, {
    method: "POST",
    headers: { ...auth(den.admin), "x-openwork-org-id": organizationId },
    body: JSON.stringify({
      policyName: "Product operations prompts",
      priority: 100,
      isEnabled: true,
      policy: {
        onboardingPrompts: ACME_DOCS_PROMPT_CARDS.map((card) => card.prompt),
        onboardingPromptDescriptions: ACME_DOCS_PROMPT_CARDS.map((card) => card.title),
      },
      memberIds: [jordanId],
      teamIds: [teamId],
    }),
  });
  if (policy.response.status !== 201) {
    throw new Error(`POST ${policyRoute} failed: HTTP ${policy.response.status} ${policy.text.slice(0, 500)}`);
  }
}

/** The organization, content, witness connection, policy, and member desktop used by docs shots. */
export async function bootAcmeDocs(
  stack: AsyncDisposableStack,
  place: Place,
): Promise<AcmeDocsWorld> {
  const den = stack.use(await server({
    place,
    provision: false,
    web: true,
    mocks: { slack: mcpMock() },
    env: { DEN_BOOTSTRAP_ADMIN_EMAILS: "alex@acme.dev" },
  }));
  const admin = await createAdmin(den, { name: "Alex Rivera", email: "alex@acme.dev" });
  const org = stack.use(await createOrg(den, ACME_DOCS_ORGANIZATION_NAME));
  const jordan = await inviteMember(den, ACME_DOCS_MEMBER, {
    name: "Jordan Lee",
    email: "jordan@acme.dev",
  });

  await enableDocsCapabilities(admin, org.id);
  const pluginIds: string[] = [];
  for (const plugin of plugins) {
    const created = await createPluginWithSkill(admin, plugin);
    pluginIds.push(created.id);
  }
  const slack = den.mocks.slack;
  if (!slack) throw new Error("The Slack MCP witness did not boot.");
  await createOrgConnection(admin, {
    name: "Slack",
    url: slack.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  await createProductOperationsPolicy(den, org.id, jordan);

  const docs = stack.use(await app({
    den,
    place,
    as: ACME_DOCS_MEMBER,
    workspacePath: ACME_DOCS_WORKSPACE,
  }));
  return {
    den,
    org,
    docs,
    pluginIds,
    app(name) {
      if (name !== ACME_DOCS_APP) throw new Error(`Unknown Acme docs app ${JSON.stringify(name)}.`);
      return docs;
    },
  };
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const world = await bootAcmeDocs(stack, resolvePlace());
  const slack = world.den.mocks.slack;
  if (!slack) throw new Error("The Slack MCP witness did not boot.");
  await hold({
    name: "acme-docs",
    outputs: {
      denWeb: world.den.ref.webUrl,
      denApi: world.den.ref.apiUrl,
      docsCdp: world.docs.handle.cdpUrl,
      slackMcp: slack.mcpUrl,
    },
  });
}

if (import.meta.main) await main();
