import { expect } from "vitest";
import { denFetch, evalIn, go, waitForText } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { app, eventually, needs, server, test } from "@openwork/testkit";

const SKILL_NOTICE = "Your organization administrator has disabled creating skills on this device.";
const MCP_NOTICE = "Your organization administrator has disabled adding MCP servers on this device.";
const REQUEST_TIMEOUT_MS = 20_000;

interface ApiResult {
  status: number;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value)}`);
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was not a non-empty string.`);
  return value;
}

function auth(session: DenSession, orgId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${session.token}`,
    ...(orgId ? { "x-openwork-org-id": orgId } : {}),
  };
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: auth(session),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = record(result.body, "organization response");
  const organization = records(body.orgs)[0];
  const id = organization ? stringField(organization.id, "organization id") : "";
  if (!result.response.ok || !id) throw new Error(`Finding the isolated organization failed with HTTP ${result.response.status}.`);
  return id;
}

async function configureLockdown(admin: DenSession, orgId: string): Promise<Record<string, unknown>> {
  const listed = await denFetch(admin, "/v1/desktop-policies", {
    headers: auth(admin, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const listBody = record(listed.body, "desktop policy list");
  const policy = records(listBody.desktopPolicies).find((entry) => entry.isDefault === true);
  if (!listed.response.ok || !policy) throw new Error(`Finding the default desktop policy failed with HTTP ${listed.response.status}.`);
  const policyId = stringField(policy.id, "default desktop policy id");
  const existingPolicy = record(policy.policy, "default desktop policy document");
  const assignments = records(policy.assignments);
  const patched = await denFetch(admin, `/v1/desktop-policies/${encodeURIComponent(policyId)}`, {
    method: "PATCH",
    headers: { ...auth(admin, orgId), "content-type": "application/json" },
    body: JSON.stringify({
      policyName: stringField(policy.policyName, "default desktop policy name"),
      policy: {
        ...existingPolicy,
        allowCreateSkills: false,
        allowAddMcpServers: false,
      },
      priority: typeof policy.priority === "number" ? policy.priority : 0,
      isEnabled: policy.isEnabled === true,
      memberIds: assignments.flatMap((entry) => typeof entry.orgMemberId === "string" ? [entry.orgMemberId] : []),
      teamIds: assignments.flatMap((entry) => typeof entry.teamId === "string" ? [entry.teamId] : []),
      roles: Array.isArray(policy.roles) ? policy.roles : [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const patchedBody = record(patched.body, "patched desktop policy response");
  const updated = record(patchedBody.desktopPolicy, "patched desktop policy");
  const updatedPolicy = record(updated.policy, "patched desktop policy document");
  const preserved = Object.entries(existingPolicy)
    .filter(([key]) => key !== "allowCreateSkills" && key !== "allowAddMcpServers")
    .every(([key, value]) => JSON.stringify(updatedPolicy[key]) === JSON.stringify(value));
  if (patched.response.status !== 200 || !preserved) {
    throw new Error(`Patching the default desktop policy failed or replaced existing values: HTTP ${patched.response.status}.`);
  }
  return updatedPolicy;
}

async function readMemberDesktopConfig(member: DenSession, orgId: string): Promise<Record<string, unknown>> {
  const result = await denFetch(member, "/v1/me/desktop-config", {
    headers: auth(member, orgId),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!result.response.ok) throw new Error(`Reading member desktop config failed with HTTP ${result.response.status}.`);
  return record(result.body, "member desktop config");
}

async function localRequest(
  desktop: Parameters<typeof evalIn>[0],
  path: string,
  input: { method?: string; body?: Record<string, unknown> } = {},
): Promise<ApiResult> {
  const raw = await evalIn(desktop, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    const baseUrl = String(info?.baseUrl ?? info?.connectUrl ?? "").replace(/\\/+$/, "");
    const token = String(info?.ownerToken ?? info?.clientToken ?? "");
    if (!baseUrl || !token) return JSON.stringify({ status: 0, body: { code: "local_server_unavailable" } });
    const response = await fetch(baseUrl + ${JSON.stringify(path)}, {
      method: ${JSON.stringify(input.method ?? "GET")},
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: ${input.body ? JSON.stringify(JSON.stringify(input.body)) : "undefined"},
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return JSON.stringify({ status: response.status, body });
  })()`, { awaitPromise: true, timeoutMs: REQUEST_TIMEOUT_MS });
  const parsed: unknown = JSON.parse(String(raw));
  const result = record(parsed, `local ${input.method ?? "GET"} ${path} response`);
  if (typeof result.status !== "number") throw new Error(`Local response had no numeric status: ${JSON.stringify(result)}`);
  return { status: result.status, body: result.body };
}

function policyState(body: unknown): Record<string, unknown> {
  return record(record(body, "desktop policy state response").state, "desktop policy state");
}

function hasLockdown(state: Record<string, unknown>): boolean {
  return state.allowCreateSkills === false && state.allowAddMcpServers === false;
}

async function exactButtonVisible(desktop: Parameters<typeof evalIn>[0], label: string): Promise<boolean> {
  return (await evalIn(desktop, `[...document.querySelectorAll("button")]
    .some((button) => (button.textContent ?? "").trim() === ${JSON.stringify(label)})`)) === true;
}

async function textVisible(desktop: Parameters<typeof evalIn>[0], text: string): Promise<boolean> {
  return (await evalIn(desktop, `(document.body?.innerText ?? "").includes(${JSON.stringify(text)})`)) === true;
}

test("Den desktop policy locks down signed-in desktop skill and MCP writes", async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  await using den = await server({
    place,
    org: {
      name: `Desktop Policy Lockdown ${Date.now()}`,
      admin: { name: "Policy Admin" },
      members: { member: { name: "Policy Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("The testkit did not provision the ordinary organization member.");
  const orgId = await organizationId(den.admin);
  const patchedPolicy = await configureLockdown(den.admin, orgId);
  const desktopConfig = await readMemberDesktopConfig(member, orgId);
  const denLocked = hasLockdown(desktopConfig);
  evidence.recordAssertionEvidence(
    "Den resolves both default desktop policy restrictions for the ordinary member",
    `Patched policy: ${JSON.stringify(patchedPolicy)}; member desktop config: ${JSON.stringify(desktopConfig)}`,
    denLocked,
  );
  expect(desktopConfig.allowCreateSkills).toBe(false);
  expect(desktopConfig.allowAddMcpServers).toBe(false);

  await using desktop = await app({ den, as: "member", place });
  const localStateResult = await eventually(
    () => localRequest(desktop, "/experimental/desktop-policy/state"),
    {
      within: 120_000,
      intervalMs: 2_000,
      label: "embedded server receives Den desktop policy",
      until: (value) => value.status === 200 && hasLockdown(policyState(value.body)),
    },
  );
  const localState = policyState(localStateResult.body);
  evidence.recordAssertionEvidence(
    "The signed-in desktop pushes both restrictions into its embedded local server",
    `Local state response: ${JSON.stringify(localStateResult)}`,
    localStateResult.status === 200 && hasLockdown(localState),
  );
  expect(hasLockdown(localState)).toBe(true);

  const capabilitiesResult = await localRequest(desktop, "/capabilities");
  const capabilities = record(capabilitiesResult.body, "capabilities response");
  const skillCapabilities = record(capabilities.skills, "skill capabilities");
  const mcpCapabilities = record(capabilities.mcp, "MCP capabilities");
  const writesDisabled = capabilitiesResult.status === 200
    && skillCapabilities.write === false
    && mcpCapabilities.write === false;
  evidence.recordAssertionEvidence(
    "Embedded server capabilities disable skill and MCP writes",
    `Capabilities response: ${JSON.stringify(capabilitiesResult)}`,
    writesDisabled,
  );
  expect(skillCapabilities.write).toBe(false);
  expect(mcpCapabilities.write).toBe(false);

  const workspaceId = desktop.workspaceId;
  const deniedSkill = await localRequest(desktop, `/workspace/${encodeURIComponent(workspaceId)}/skills`, {
    method: "POST",
    body: { name: "blocked-skill", content: "# Blocked skill" },
  });
  const deniedSkillBody = record(deniedSkill.body, "denied skill write response");
  const deniedSkillDetails = record(deniedSkillBody.details, "denied skill write details");
  const skillDenied = deniedSkill.status === 403
    && deniedSkillBody.code === "policy_restricted"
    && deniedSkillDetails.policy === "allowCreateSkills";
  evidence.recordAssertionEvidence(
    "Embedded server rejects skill creation under the Den policy",
    `Denied skill response: ${JSON.stringify(deniedSkill)}`,
    skillDenied,
  );
  expect(skillDenied).toBe(true);

  const deniedMcp = await localRequest(desktop, `/workspace/${encodeURIComponent(workspaceId)}/mcp`, {
    method: "POST",
    body: { name: "blocked-mcp", config: { type: "remote", url: "https://blocked.invalid/mcp" } },
  });
  const deniedMcpBody = record(deniedMcp.body, "denied MCP write response");
  const deniedMcpDetails = record(deniedMcpBody.details, "denied MCP write details");
  const mcpDenied = deniedMcp.status === 403
    && deniedMcpBody.code === "policy_restricted"
    && deniedMcpDetails.policy === "allowAddMcpServers";
  evidence.recordAssertionEvidence(
    "Embedded server rejects MCP creation under the Den policy",
    `Denied MCP response: ${JSON.stringify(deniedMcp)}`,
    mcpDenied,
  );
  expect(mcpDenied).toBe(true);

  await go(desktop, `/workspace/${workspaceId}/extensions/skills`);
  await waitForText(desktop, SKILL_NOTICE, { timeoutMs: 60_000 });
  const skillNoticeVisible = await textVisible(desktop, SKILL_NOTICE);
  const addSkillVisible = await exactButtonVisible(desktop, "Add skill");
  expect(skillNoticeVisible).toBe(true);
  expect(addSkillVisible).toBe(false);
  await go(desktop, `/workspace/${workspaceId}/extensions/mcps`);
  await waitForText(desktop, MCP_NOTICE, { timeoutMs: 60_000 });
  const mcpNoticeVisible = await textVisible(desktop, MCP_NOTICE);
  const addMcpVisible = await exactButtonVisible(desktop, "Add MCP");
  const uiLocked = skillNoticeVisible && mcpNoticeVisible && !addSkillVisible && !addMcpVisible;
  evidence.recordAssertionEvidence(
    "Desktop extension routes explain the policy and hide exact add actions",
    `Saw exact notices ${JSON.stringify([SKILL_NOTICE, MCP_NOTICE])}; Add skill visible: ${addSkillVisible}; Add MCP visible: ${addMcpVisible}.`,
    uiLocked,
  );
  expect(mcpNoticeVisible).toBe(true);
  expect(addMcpVisible).toBe(false);
});
