import { allocateFreePorts } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { isRecord, records, stringField } from "./library.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * One organization with three plain members: Sam owns an Automation, Riley is
 * the teammate Sam shares it with, and Jo is never shared with. Sam and Riley
 * each have the real app open in headless Chrome. No run executes, so the
 * model provider endpoint is never called.
 */
export async function automationSharingWorld(seed: Seed) {
  const stamp = Date.now();
  const [teammatePort] = await allocateFreePorts(1);
  if (!teammatePort) throw new Error("No port for the teammate's app.");
  const { den, webPort } = await denForAppWeb(seed, {
    trustedOrigins: [`http://127.0.0.1:${teammatePort}`],
    env: { DEN_AUTOMATIONS_ENABLED: "true", DEN_AUTOMATIONS_RUNTIME_ENABLED: "true" },
    org: {
      name: `Sharing Lab ${stamp}`,
      admin: { name: "Avery Admin" },
      members: { owner: { name: "Sam Owner" }, teammate: { name: "Riley Teammate" }, outsider: { name: "Jo Outsider" } },
    },
  });
  const owner = den.members.owner;
  const teammate = den.members.teammate;
  const outsider = den.members.outsider;
  if (!owner || !teammate || !outsider) throw new Error("The seeded organization is missing a member.");
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("Could not resolve the seeded organization.");

  const modelId = "automation-model";
  const provider = await seed.api(den.admin, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Automation provider", source: "custom", allMembers: true, memberIds: [], teamIds: [],
      apiKey: "synthetic-automation-key",
      customConfig: {
        id: "automation-provider", name: "Automation provider", npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "http://127.0.0.1:9/v1" }, env: ["AUTOMATION_FIXTURE_API_KEY"],
        models: [{ id: modelId, name: "Automation model", tool_call: true }],
      },
    }),
  });
  const providerId = isRecord(provider.body) ? stringField(provider.body.llmProvider, "id") : "";
  if (provider.response.status !== 201 || !providerId) {
    throw new Error(`Creating the organization provider failed: HTTP ${provider.response.status} ${provider.text.slice(0, 500)}`);
  }

  const name = "Daily pipeline digest";
  const created = await seed.api(owner, "/v1/automations", {
    method: "POST",
    body: JSON.stringify({
      name,
      instructions: "Summarize today's pipeline changes and post the digest.",
      schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
      model: { providerId, modelId, variant: null },
    }),
  });
  const automationId = isRecord(created.body) ? stringField(created.body.automation, "id") : "";
  if (created.response.status !== 201 || !automationId) {
    throw new Error(`Creating the owner's Automation failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }

  type Member = typeof owner;
  // Advertise a Desktop for each person so Desktop Automations are offered.
  async function advertiseDesktop(member: Member, runnerId: string) {
    const registered = await seed.api(member, "/v1/automation-runners/token", {
      method: "POST",
      body: JSON.stringify({ runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.0.0", platform: "linux", concurrency: 1, capabilities: [] }),
    });
    if (registered.response.status !== 200) throw new Error(`Desktop registration failed: HTTP ${registered.response.status}`);
  }
  await advertiseDesktop(owner, "sharing-owner-desktop");
  await advertiseDesktop(teammate, "sharing-teammate-desktop");

  const viewport = { width: 1280, height: 860 };
  const ownerApp = await signedInAppWeb(seed, { den, webPort, as: "owner", workspacePath: seed.tmpPath("sharing-owner"), headless: true, viewport });
  const teammateApp = await signedInAppWeb(seed, { den, webPort: teammatePort, as: "teammate", workspacePath: seed.tmpPath("sharing-teammate"), headless: true, viewport });

  /** What Den lists as shared with one person: names and who shared them. */
  async function sharedWith(member: Member) {
    const result = await seed.api(member, "/v1/shared-automations");
    const items = isRecord(result.body) ? records(result.body.items) : [];
    return {
      status: result.response.status,
      error: isRecord(result.body) ? stringField(result.body, "error") : "",
      items: items.map((item) => ({ id: stringField(item, "id"), name: stringField(item, "name"), sharedBy: stringField(item.sharedBy, "name") })),
    };
  }
  /** One person's own Automations: name, state and whether a next run is due. */
  async function ownAutomations(member: Member) {
    const result = await seed.api(member, "/v1/automations");
    const items = isRecord(result.body) ? records(result.body.items) : [];
    return items.map((item) => ({
      id: stringField(item.automation, "id"),
      name: stringField(item.automation, "name"),
      state: stringField(item.automation, "state"),
      scheduled: isRecord(item.automation) && item.automation.nextDueAt != null,
    }));
  }

  return {
    den, name, automationId,
    owner: ownerApp.app, teammate: teammateApp.app,
    ownerName: "Sam Owner", teammateName: "Riley Teammate",
    /** Switches Automation sharing on or off for the organization, as /admin does. */
    async setSharing(enabled: boolean) {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
        method: "PUT",
        body: JSON.stringify({ capabilities: { automationSharing: enabled } }),
      });
      if (!result.response.ok) throw new Error(`Setting Automation sharing failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
    },
    sharedWithTeammate: () => sharedWith(teammate),
    sharedWithOutsider: () => sharedWith(outsider),
    teammateAutomations: () => ownAutomations(teammate),
    ownerAutomations: () => ownAutomations(owner),
    /** Whether Den lets the outsider add a copy of the owner's Automation. */
    async outsiderCopy() {
      const result = await seed.api(outsider, `/v1/shared-automations/${automationId}/copy`, { method: "POST", body: "{}" });
      return { status: result.response.status, error: isRecord(result.body) ? stringField(result.body, "error") : "" };
    },
  };
}
