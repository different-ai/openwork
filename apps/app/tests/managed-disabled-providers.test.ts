import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createClient } from "../src/app/lib/opencode";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { readManagedDisabledProviders } from "../src/react-app/domains/connections/managed-engine-config";
import { reconcilePolicyDisabledProviders } from "../src/react-app/domains/connections/policy-provider-reconcile";

const RUNTIME_PATH = "/workspace/workspace/runtime-config/disabled-providers";

beforeEach(() => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
});
afterEach(async () => {
  await GlobalRegistrator.unregister();
});

function mockServer(runtime: { list: string[] }, v1Config: Record<string, unknown> = {}) {
  const writes: string[][] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === RUNTIME_PATH && request.method === "POST") {
      const body: unknown = await request.json();
      const providers = typeof body === "object" && body !== null && "providers" in body && Array.isArray(body.providers)
        ? body.providers.filter((entry): entry is string => typeof entry === "string") : [];
      writes.push(providers);
      runtime.list = providers;
      return Response.json({ ok: true, disabledProviders: providers });
    }
    if (path === RUNTIME_PATH) return Response.json({ ok: true, disabledProviders: runtime.list });
    if (path === "/opencode/config") return Response.json(v1Config);
    return Response.json({});
  });
  return { writes, restore: () => fetch.mockRestore() };
}

const server = () => createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "client", hostToken: "host" });

test("ENG-994: v1 reads include a provider disabled on the server before v1 reloads", async () => {
  // v2 chat routing never reloads v1, so its config still lacks the provider
  // the person just disconnected. The Disconnect check then failed with
  // "Disconnection could not be verified".
  const runtime = { list: ["opencode", "remote"] };
  const mock = mockServer(runtime, { disabled_providers: ["opencode"] });
  try {
    const disabled = await readManagedDisabledProviders({
      opencodeClient: createClient("http://localhost:8787/opencode", "/workspace", { mode: "openwork", token: "client" }),
      openworkClient: server(),
      workspaceId: "workspace",
      workspaceType: "local",
    });
    expect(disabled).toEqual(["opencode", "remote"]);
  } finally {
    mock.restore();
  }
});

test("ENG-994: v1 reads outside a managed local workspace still come from the engine config", async () => {
  const runtime = { list: ["remote"] };
  const mock = mockServer(runtime, { disabled_providers: ["opencode"] });
  try {
    const disabled = await readManagedDisabledProviders({
      opencodeClient: createClient("http://localhost:8787/opencode", "/workspace", { mode: "openwork", token: "client" }),
      openworkClient: server(),
      workspaceId: "workspace",
      workspaceType: "remote",
    });
    expect(disabled).toEqual(["opencode"]);
  } finally {
    mock.restore();
  }
});

test("ENG-994: policy reconcile builds on the current list, not a route's stale copy", async () => {
  // Another route disabled `remote` after this route read its list. Writing the
  // stale list plus the policy-blocked provider silently re-enabled `remote`.
  const runtime = { list: ["remote"] };
  const mock = mockServer(runtime);
  const reported: string[][] = [];
  try {
    const result = await reconcilePolicyDisabledProviders({
      opencodeClient: createClientV2("http://localhost:8787/opencode2", "/workspace", {}),
      openworkClient: server(),
      workspaceId: "workspace",
      workspaceType: "local",
      allProviders: [{ id: "anthropic" }, { id: "remote" }],
      connectedProviderIds: ["anthropic"],
      disabledProviderIds: [],
      // Only Cloud providers are allowed, so `anthropic` must be disabled.
      checkRestriction: ({ restriction }) => restriction === "allowCustomProviders",
      storage: null,
      setDisabledProviders: (providers) => reported.push(providers),
    });
    expect(mock.writes).toEqual([["remote", "anthropic"]]);
    expect(runtime.list).toEqual(["remote", "anthropic"]);
    expect(result.disabledProviderIds).toEqual(["remote", "anthropic"]);
    expect(reported.at(-1)).toEqual(["remote", "anthropic"]);
  } finally {
    mock.restore();
  }
});

test("ENG-994: policy reconcile does not write when the current list already satisfies the policy", async () => {
  const runtime = { list: ["anthropic", "remote"] };
  const mock = mockServer(runtime);
  try {
    await reconcilePolicyDisabledProviders({
      opencodeClient: createClientV2("http://localhost:8787/opencode2", "/workspace", {}),
      openworkClient: server(),
      workspaceId: "workspace",
      workspaceType: "local",
      allProviders: [{ id: "anthropic" }, { id: "remote" }],
      connectedProviderIds: ["anthropic"],
      disabledProviderIds: [],
      checkRestriction: ({ restriction }) => restriction === "allowCustomProviders",
      storage: null,
    });
    expect(mock.writes).toEqual([]);
    expect(runtime.list).toEqual(["anthropic", "remote"]);
  } finally {
    mock.restore();
  }
});
