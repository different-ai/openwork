import assert from "node:assert/strict";
import { browserScript, probeAppStateOnSurface } from "../../evals/packages/cdp/src/index.ts";
import type { Surface } from "../../evals/packages/cdp/src/index.ts";
import type { DenSession } from "../../evals/packages/behaviors/src/den.ts";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import { control, evalIn, fill, waitFor } from "../../evals/packages/behaviors/src/desktop.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function workshopSessionIdFromRoute(route: string): string {
  const id = /\/session\/([^/?#]+)/.exec(route)?.[1];
  assert.ok(id, "Select an existing workshop session before binding its model");
  return id;
}
export function availableWorkshopModel(value: unknown, modelId: string) {
  const models = record(value) && Array.isArray(value.models) ? value.models.filter(record) : [];
  const matches = models.filter((model) => model.modelId === modelId && model.available === true && typeof model.providerId === "string");
  assert.equal(matches.length, 1, "Managed workshop alias must be uniquely available in this member's actual engine catalog");
  const model = matches[0]; assert.ok(model && typeof model.providerId === "string");
  return { providerId: model.providerId, modelId, displayName: typeof model.displayName === "string" ? model.displayName : modelId };
}

/** Same supported owned-runtime handoff as bootAcmeWeb/workshop-agent; never installs an upstream key. */
export async function linkWorkshopRuntime(surface: Surface, member: DenSession, orgId: string, workspaceId: string) {
  const auth = await control(surface, "auth.status");
  assert.ok(record(auth) && record(auth.user) && auth.user.email === member.email, "Runtime handoff must match the desktop's already signed-in ordinary member");
  const minted = await denFetch(member, "/v1/mcp/token", { method: "POST", headers: { authorization: `Bearer ${member.token}`, "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
  assert.ok(minted.response.ok && record(minted.body) && typeof minted.body.token === "string", "Ordinary member MCP token could not be issued");
  const result = await evalIn(surface, browserScript(async (apiUrl, memberToken, orgId, workspaceId, mcpToken) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.running || !info.baseUrl || !info.hostToken || !info.ownerToken) throw new Error("Owned desktop runtime is unavailable");
    const root = info.baseUrl.replace(/\/$/, "");
    const link = await fetch(`${root}/den-session`, { method: "PUT", headers: { "x-openwork-host-token": info.hostToken, "content-type": "application/json" }, body: JSON.stringify({ baseUrl: apiUrl, token: memberToken, orgId }) });
    if (!link.ok) throw new Error(`Member runtime handoff HTTP ${link.status}`);
    const sync = await fetch(`${root}/cloud-provider-sync/run`, { method: "POST", headers: { "x-openwork-host-token": info.hostToken, "content-type": "application/json" }, body: JSON.stringify({ reason: "manual" }) });
    if (!sync.ok) throw new Error(`Managed provider synchronization HTTP ${sync.status}`);
    const reconcile = await fetch(`${root}/workspace/${encodeURIComponent(workspaceId)}/mcp/openwork-cloud/reconcile`, { method: "POST", headers: { authorization: `Bearer ${info.ownerToken}`, "content-type": "application/json" }, body: JSON.stringify({ config: { type: "remote", url: `${apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${mcpToken}` } }, trigger: "workshop-proof" }) });
    if (!reconcile.ok) throw new Error(`Member MCP reconciliation HTTP ${reconcile.status}`);
    return { memberLinked: true, providerSyncRequested: true, ownMemberMcpReconciled: true };
  }, [member.apiUrl, member.token, orgId, workspaceId, minted.body.token]), { timeoutMs: 120_000 });
  assert.ok(record(result) && result.memberLinked === true); return result;
}

/** Current native picker contract: no dependency on the retired dialog/placeholder. */
export async function selectWorkshopModel(surface: Surface, modelId: string) {
  const app = await probeAppStateOnSurface(surface); assert.ok(app.workspaceId);
  const deadline = Date.now() + 120_000;
  let catalog: unknown;
  for (;;) {
    catalog = await control(surface, "models.list", { workspaceId: app.workspaceId });
    try { availableWorkshopModel(catalog, modelId); break; } catch { if (Date.now() >= deadline) throw new Error("Managed workshop alias did not reach this member's desktop engine; refusing free-model fallback"); }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const model = availableWorkshopModel(catalog, modelId);
  const selector = 'input[aria-label="Search all models"]';
  if (!await evalIn(surface, browserScript((selector) => Boolean(document.querySelector(selector)), [selector]))) await control(surface, "session.model_picker.open");
  await waitFor(surface, browserScript((selector) => Boolean(document.querySelector(selector)), [selector]), { timeoutMs: 30_000, label: "current native model search" });
  // Do not feed provider-like model words into the semantic search parser:
  // inspect the real full catalog by its stable model identity instead.
  await fill(surface, selector, "");
  const key = `${model.providerId}:${model.modelId}`;
  await waitFor(surface, browserScript((key) => [...document.querySelectorAll<HTMLElement>("[data-model-key]")].some((row) => row.dataset.modelKey === key && row.getAttribute("aria-disabled") !== "true" && !row.hasAttribute("data-disabled")), [key]), { timeoutMs: 30_000, label: "managed alias selectable in the real native model picker" });
  await evalIn(surface, browserScript((key) => {
    const row = [...document.querySelectorAll<HTMLElement>("[data-model-key]")].find((row) => row.dataset.modelKey === key);
    if (!row) throw new Error("Managed model row disappeared before selection"); row.click(); return true;
  }, [key]));
  await waitFor(surface, browserScript((selector) => !document.querySelector(selector), [selector]), { timeoutMs: 30_000, label: "native picker selection applied" });
  // An empty session legitimately has no transcript yet. Its actual route
  // identifies it without inventing a first message just to obtain an id.
  const sessionId = workshopSessionIdFromRoute(app.route);
  const binding = await control(surface, "session.set_model", { workspaceId: app.workspaceId, sessionId, providerId: model.providerId, modelId: model.modelId, variant: "low" });
  assert.ok(record(binding) && binding.ok === true, "Managed model/low-effort binding did not verify");
  return model;
}
