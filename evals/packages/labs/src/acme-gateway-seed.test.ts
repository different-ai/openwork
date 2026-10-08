import { beforeEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { ACME_MODEL, ACME_REPLY, record, seedAcmeGateway, startAcmeUpstream } from "../../../../worlds/lib/acme-gateway.ts";
import type { DenSession } from "../../behaviors/src/den.ts";

const mocks = vi.hoisted(() => ({ denFetch: vi.fn() }));
vi.mock("../../behaviors/src/den.ts", () => ({ denFetch: mocks.denFetch }));
vi.mock("../../env/src/den.ts", () => ({ server: vi.fn() }));
vi.mock("../../cdp/src/index.ts", () => ({ allocateFreePort: vi.fn() }));
vi.mock("../../hosts/src/index.ts", () => ({ defaultDaytonaExec: vi.fn(), execInSandbox: vi.fn(), startScriptOnSandbox: vi.fn() }));
vi.mock("../../../../packages/world/src/ledger.ts", () => ({ trackResource: vi.fn() }));

// Minimal Anthropic catalog fixture: use an actual supported identity, not an
// invented version/date. Provider creation rejects unknown IDs before chat.
const catalog = new Map([
  ["claude-haiku-4-5", "Claude Haiku 4.5 (latest)"],
  ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
]);
const session: DenSession = {
  apiUrl: "http://fixture.test", webUrl: "http://fixture.test", token: "fixture-token",
  email: "owner@fixture.test", password: "fixture-password",
};
const upstream = { key: "fixture-upstream-key", baseUrl: "http://127.0.0.1:3990" };
function answer(status: number, body: unknown) {
  return { response: new Response(JSON.stringify(body), { status }), body };
}

beforeEach(() => { mocks.denFetch.mockReset(); });

it("the seeded identity exists in the generated provider catalog snapshot", async () => {
  const snapshot: unknown = JSON.parse(await readFile(new URL("../../../../ee/apps/gateway/src/models/base.json", import.meta.url), "utf8"));
  if (!record(snapshot) || !record(snapshot.anthropic) || !record(snapshot.anthropic.models)) {
    throw new Error("Missing Anthropic catalog snapshot");
  }
  const model = snapshot.anthropic.models[ACME_MODEL];
  expect(record(model) && model.id === ACME_MODEL).toBe(true);
});

it("creates and connects the seeded provider using a catalog-supported model", async () => {
  mocks.denFetch.mockImplementation(async (_session: DenSession, path: string, options?: RequestInit) => {
    if (path === "/v1/me/orgs") return answer(200, { orgs: [{ id: "org_fixture" }] });
    if (path === "/v1/inference-providers") {
      const payload: unknown = JSON.parse(String(options?.body));
      if (typeof payload !== "object" || payload === null || !("providerId" in payload) || !("modelIds" in payload)) {
        throw new Error("Invalid provider fixture payload");
      }
      expect(payload.providerId).toBe("anthropic");
      expect(payload.modelIds).toEqual([ACME_MODEL]);
      return catalog.has(ACME_MODEL)
        ? answer(201, { inferenceProvider: { id: "ipr_fixture" } })
        : answer(404, { error: "model_not_found" });
    }
    if (path === "/v1/inference-providers/ipr_fixture/connect") {
      return answer(200, { inferenceProvider: { models: [{ id: "gwm_fixture", name: catalog.get(ACME_MODEL) }] } });
    }
    throw new Error(`Unexpected fixture route ${path}`);
  });
  await expect(seedAcmeGateway(session, upstream)).resolves.toEqual({
    orgId: "org_fixture", providerId: "ipr_fixture", modelId: "gwm_fixture", modelName: catalog.get(ACME_MODEL),
  });
  expect(mocks.denFetch).toHaveBeenCalledTimes(3);
});

it("reports the catalog rejection code and never attempts to connect a rejected provider", async () => {
  mocks.denFetch.mockResolvedValueOnce(answer(200, { orgs: [{ id: "org_fixture" }] }));
  mocks.denFetch.mockResolvedValueOnce(answer(404, { error: "model_not_found" }));
  await expect(seedAcmeGateway(session, upstream)).rejects.toThrow("HTTP 404 (model_not_found)");
  expect(mocks.denFetch).toHaveBeenCalledTimes(2);
});

it("does not expose arbitrary provider response text in setup errors", async () => {
  mocks.denFetch.mockResolvedValueOnce(answer(200, { orgs: [{ id: "org_fixture" }] }));
  mocks.denFetch.mockResolvedValueOnce(answer(404, { error: "fixture secret response", message: "private fixture detail" }));
  await expect(seedAcmeGateway(session, upstream)).rejects.toThrow(/^Acme provider creation failed: HTTP 404$/);
});

it("the deterministic upstream accepts the seeded alias and rejects an invented model", async () => {
  await using stack = new AsyncDisposableStack();
  const server = await startAcmeUpstream(stack);
  const send = (model: string) => fetch(`${server.baseUrl}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": server.key },
    body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: "user", content: "hello" }] }),
  });
  const accepted = await send(ACME_MODEL);
  expect(accepted.status).toBe(200);
  expect(await accepted.text()).toContain(ACME_REPLY);
  const rejected = await send("fixture-invented-model");
  expect(rejected.status).toBe(400);
  await rejected.text();
});
