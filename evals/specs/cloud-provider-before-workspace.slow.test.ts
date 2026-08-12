import { expect, onTestFinished } from "vitest";
import { createAndSelectWorkspace, denFetch, evalIn, readAvailableModels } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { eventually, needs, server, signInDesktopAs, test } from "@openwork/testkit";

const ORGANIZATION_NAME = "Cloud Provider Before Workspace";
const PROVIDER_NAME = "First Workspace Models";
const PROVIDER_KEY = "first-workspace-models";
const MODEL_ID = "first-workspace-proof-model";
const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: auth(session),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = result.body;
  const organizations = isRecord(body) && Array.isArray(body.orgs) ? body.orgs.filter(isRecord) : [];
  const organization = organizations.find((entry) => entry.name === ORGANIZATION_NAME);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) throw new Error(`Finding the test organization failed with HTTP ${result.response.status}.`);
  return id;
}

async function createProvider(admin: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
    body: JSON.stringify({
      name: PROVIDER_NAME,
      source: "custom",
      customConfig: {
        id: PROVIDER_KEY,
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        env: ["FIRST_WORKSPACE_PROVIDER_API_KEY"],
        models: [{ id: MODEL_ID, name: "First Workspace Proof Model" }],
      },
      apiKey: "sk-openwork-first-workspace-eval-only",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = result.body;
  const provider = isRecord(body) && isRecord(body.llmProvider) ? body.llmProvider : null;
  const id = provider && typeof provider.id === "string" ? provider.id : "";
  if (result.response.status !== 201 || !id) throw new Error(`Creating the provider failed with HTTP ${result.response.status}.`);
  return id;
}

async function localServerRequest(
  app: Parameters<typeof evalIn>[0],
  path: string,
  input: { method?: string; body?: Record<string, unknown>; host?: boolean } = {},
): Promise<Record<string, unknown>> {
  const result = await evalIn(app, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { status: 0, body: { error: "local_server_unavailable" } };
    const headers = { "content-type": "application/json" };
    if (${input.host === true}) headers["x-openwork-host-token"] = String(info.hostToken ?? "");
    else headers.authorization = "Bearer " + String(info.ownerToken ?? info.clientToken ?? "");
    const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + ${JSON.stringify(path)}, {
      method: ${JSON.stringify(input.method ?? "GET")},
      headers,
      body: ${input.body ? JSON.stringify(JSON.stringify(input.body)) : "undefined"},
    });
    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, body };
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  if (!isRecord(result)) throw new Error(`Invalid local server response: ${JSON.stringify(result)}`);
  return result;
}

test("managed models survive sign-in before the first workspace exists", async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });
  await using den = await server({
    place,
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Provider Admin" },
      members: { member: { name: "Provider Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("The testkit did not provision the organization member.");
  const orgId = await organizationId(den.admin);
  const providerId = await createProvider(den.admin, orgId);
  onTestFinished(async () => {
    await denFetch(den.admin, `/v1/llm-providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE",
      headers: { ...auth(den.admin), "x-openwork-org-id": orgId },
    }).catch(() => undefined);
  });

  await using desktopApp = await desktop({
    name: "provider-before-workspace",
    host: place.host(),
    bootstrap: {
      baseUrl: den.ref.webUrl,
      apiBaseUrl: den.ref.webUrl,
      requireSignin: false,
    },
  });
  await signInDesktopAs(desktopApp, den.ref, member);

  // Deliver the Den session to the local server the same way the desktop
  // runtime does (PUT /den-session), while zero workspaces exist. This is the
  // exact state that used to fail every sync with workspace_missing.
  const sessionPush = await localServerRequest(desktopApp, "/den-session", {
    method: "PUT",
    host: true,
    body: { baseUrl: den.ref.apiUrl, token: member.token, orgId },
  });
  expect(sessionPush.status).toBe(204);
  const syncRun = await localServerRequest(desktopApp, "/cloud-provider-sync/run", {
    method: "POST",
    host: true,
    body: { reason: "eval_before_workspace" },
  });
  const syncRunBody = isRecord(syncRun.body) ? syncRun.body : {};
  evidence.fact(
    "A sync with zero workspaces no longer fails with workspace_missing",
    `Run result: ${JSON.stringify(syncRunBody)}`,
    syncRun.status === 200 && (syncRunBody.status === "applied" || syncRunBody.status === "noop"),
  );
  expect(syncRun.status).toBe(200);
  expect(syncRunBody.status === "applied" || syncRunBody.status === "noop", JSON.stringify(syncRunBody)).toBe(true);

  const initialStatus = await eventually(
    () => localServerRequest(desktopApp, "/cloud-provider-sync/status"),
    {
      within: 60_000,
      intervalMs: 2_000,
      label: "provider sync before workspace creation",
      until: (value) => {
        const body = isRecord(value.body) ? value.body : {};
        const lastRun = isRecord(body.lastRun) ? body.lastRun : {};
        return value.status === 200 && typeof lastRun.status === "string";
      },
    },
  );
  const initialBody = isRecord(initialStatus.body) ? initialStatus.body : {};
  const initialLastRun = isRecord(initialBody.lastRun) ? initialBody.lastRun : {};
  const initialProviders = Array.isArray(initialBody.providers) ? initialBody.providers.filter(isRecord) : [];
  const initialSucceeded = initialLastRun.status !== "failed"
    && initialLastRun.message !== "workspace_missing"
    && initialProviders.some((provider) => provider.name === PROVIDER_NAME);
  evidence.fact(
    "Provider sync succeeds before a workspace exists",
    `Sync status: ${JSON.stringify(initialBody)}`,
    initialSucceeded,
  );
  expect(initialSucceeded).toBe(true);

  const preWorkspaceModels = await eventually(
    () => readAvailableModels(desktopApp),
    {
      within: 30_000,
      intervalMs: 1_000,
      label: "assigned model in the picker before workspace creation",
      until: (candidates) => candidates.some(
        (candidate) => candidate.id === MODEL_ID && candidate.selectable,
      ),
    },
  );
  const preWorkspaceModel = preWorkspaceModels.find(
    (candidate) => candidate.id === MODEL_ID && candidate.selectable,
  );
  evidence.fact(
    "Assigned models are visible before the first workspace exists",
    `Selectable model: ${JSON.stringify(preWorkspaceModel)}`,
    preWorkspaceModel?.id === MODEL_ID && preWorkspaceModel.selectable,
  );
  expect(preWorkspaceModel?.id).toBe(MODEL_ID);
  expect(preWorkspaceModel?.selectable).toBe(true);

  // The first workspace is created through the product itself: organization
  // onboarding plus the app's workspace.create action, the same journey a
  // person takes right after this sign-in.
  const workspacePath = `/tmp/openwork-provider-before-workspace-${Date.now()}`;
  const { workspaceId } = await createAndSelectWorkspace(desktopApp, { path: workspacePath });
  expect(workspaceId).not.toBe("");
  const models = await eventually(
    () => readAvailableModels(desktopApp),
    {
      within: 120_000,
      intervalMs: 3_000,
      label: "managed model after first workspace creation",
      until: (candidates) => candidates.some((candidate) => candidate.id === MODEL_ID && candidate.selectable),
    },
  );
  const model = models.find((candidate) => candidate.id === MODEL_ID && candidate.selectable);
  evidence.fact(
    "The first workspace receives the already-synced model without restarting",
    `Selectable model: ${JSON.stringify(model)}`,
    model?.id === MODEL_ID && model.selectable,
  );
  expect(model?.id).toBe(MODEL_ID);
  expect(model?.selectable).toBe(true);

  const finalStatus = await localServerRequest(desktopApp, "/cloud-provider-sync/status");
  const finalBody = isRecord(finalStatus.body) ? finalStatus.body : {};
  const finalLastRun = isRecord(finalBody.lastRun) ? finalBody.lastRun : {};
  const noWorkspaceFailure = finalLastRun.status !== "failed" && finalLastRun.message !== "workspace_missing";
  evidence.fact(
    "Workspace creation does not reintroduce the sync failure",
    `Final sync status: ${JSON.stringify(finalBody)}`,
    noWorkspaceFailure,
  );
  expect(noWorkspaceFailure).toBe(true);
});
