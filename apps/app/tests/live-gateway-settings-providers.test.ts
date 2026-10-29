import { describe, expect, spyOn, test } from "bun:test";
import { createDenClient } from "../src/app/lib/den";
import {
  isLiveGatewaySetConnected,
  resolveGatewayProviderIds,
  resolveLiveGatewayConnectProviders,
  resolveLiveGatewayImportedProviders,
  type LiveGatewayProvider,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

// Crockford-base32 ULID-shaped suffixes, matching Den's id format.
const group = "01m292yddve0pbd5rnb30rk3ap";
const readySet = "01m292ydevejz88xgn8dhsdy22";
const pendingSet = "01m292yde8escv5k6jkfwq8y1n";
const modelSuffix = "01m356j44dec4r73nsa53rmpa9";

const model = (credentialSet: string) => ({
  id: `gwm_${group}_${credentialSet}_${modelSuffix}`,
  name: "Claude",
  config: { id: `gwm_${group}_${credentialSet}_${modelSuffix}` },
  upstreamModelId: "claude-sonnet",
  modelGroupId: `gmg_${group}`,
  modelGroupName: "Default",
  credentialSetId: `gcs_${credentialSet}`,
  credentialSetName: credentialSet === readySet ? "Shared" : "Personal",
});

const ready: LiveGatewayProvider = {
  id: "ipr_ready",
  providerId: "anthropic",
  name: "Anthropic",
  credentialStatus: "ready",
  updatedAt: "2026-10-28T00:00:00.000Z",
  models: [model(readySet)],
  authorizationRequests: [],
};

const memberOnly: LiveGatewayProvider = {
  id: "ipr_member",
  providerId: "openai",
  name: "OpenAI",
  credentialStatus: "member_auth_required",
  updatedAt: "2026-10-28T00:00:00.000Z",
  models: [],
  authorizationRequests: [],
};

const mixed: LiveGatewayProvider = {
  ...ready,
  id: "ipr_mixed",
  name: "Bedrock",
  authorizationRequests: [{ credentialSetId: `gcs_${pendingSet}`, name: "Personal", authUrl: "https://den.example.test/auth", models: [model(pendingSet)] }],
};

const missing: LiveGatewayProvider = { ...memberOnly, id: "ipr_missing", credentialStatus: "org_credential_missing" };

describe("Settings lists Gateway providers under live provider sync", () => {
  test("ready providers become organization rows badged as OpenWork Gateway", () => {
    const rows = resolveLiveGatewayImportedProviders([ready, memberOnly, mixed, missing]);
    expect(Object.keys(rows).sort()).toEqual(["ipr_mixed", "ipr_ready"]);
    expect(rows.ipr_ready).toEqual({
      cloudProviderId: "ipr_ready",
      providerId: "ipr_ready",
      sourceProviderId: "anthropic",
      name: "Anthropic",
      source: "openwork_gateway",
      updatedAt: "2026-10-28T00:00:00.000Z",
      modelIds: [model(readySet).id],
      importedAt: null,
    });
    expect([...resolveGatewayProviderIds(rows)].sort()).toEqual(["ipr_mixed", "ipr_ready"]);
  });

  test("pending member sign-ins become Connect rows like the server sync's skips", () => {
    expect(resolveLiveGatewayConnectProviders([ready, memberOnly, mixed, missing])).toEqual([
      { cloudProviderId: "ipr_member", providerId: "ipr_member", name: "OpenAI", authUrl: null },
      {
        cloudProviderId: "ipr_mixed",
        credentialSetId: `gcs_${pendingSet}`,
        models: [model(pendingSet)],
        providerId: "ipr_mixed",
        name: "Bedrock / Personal",
        authUrl: null,
      },
    ]);
  });

  test("a sign-in counts as connected only once Den stops asking for it", () => {
    const [memberRow, setRow] = resolveLiveGatewayConnectProviders([memberOnly, mixed]);
    expect(isLiveGatewaySetConnected(memberRow, [memberOnly])).toBe(false);
    expect(isLiveGatewaySetConnected(memberRow, [{ ...memberOnly, credentialStatus: "ready", models: [model(readySet)] }])).toBe(true);
    expect(isLiveGatewaySetConnected(setRow, [mixed])).toBe(false);
    expect(isLiveGatewaySetConnected(setRow, [{ ...mixed, authorizationRequests: [] }])).toBe(false);
    expect(isLiveGatewaySetConnected(setRow, [{ ...mixed, authorizationRequests: [], models: [model(readySet), model(pendingSet)] }])).toBe(true);
    expect(isLiveGatewaySetConnected(setRow, [])).toBe(false);
  });
});

describe("listOrgUsableGatewayProviders", () => {
  const withFetch = async (respond: () => Response, run: (client: ReturnType<typeof createDenClient>) => Promise<void>) => {
    const requests: Array<{ path: string; org: string | null }> = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requests.push({ path: url.pathname + url.search, org: new Headers(init?.headers).get("x-openwork-org-id") });
      return respond();
    });
    try {
      await run(createDenClient({ baseUrl: "https://den.example.test", apiBaseUrl: "https://den.example.test", token: "member-token" }));
    } finally { fetch.mockRestore(); }
    return requests;
  };

  test("reads the member's usable providers and drops only malformed rows and models", async () => {
    const requests = await withFetch(() => Response.json({ inferenceProviders: [
      { ...ready, source: "openwork_gateway", models: [model(readySet), { id: "not-a-gateway-model" }], authorizationRequests: [{ credentialSetId: "bad", name: "x", authUrl: "y" }] },
      { ...mixed, source: "openwork_gateway" },
      { id: "lpr_legacy", providerId: "x", name: "Legacy", source: "openwork_gateway", credentialStatus: "ready" },
      { ...memberOnly, source: "custom" },
    ] }), async (client) => {
      const providers = await client.listOrgUsableGatewayProviders("org-a");
      expect(providers.map((provider) => provider.id)).toEqual(["ipr_ready", "ipr_mixed"]);
      expect(providers[0]?.models.map((entry) => entry.id)).toEqual([model(readySet).id]);
      expect(providers[0]?.authorizationRequests).toEqual([]);
      expect(providers[1]?.authorizationRequests[0]?.models?.map((entry) => entry.id)).toEqual([model(pendingSet).id]);
    });
    expect(requests).toEqual([{ path: "/v1/inference-providers?scope=usable", org: "org-a" }]);
  });

  test("Den servers without Gateway list nothing; other failures surface", async () => {
    await withFetch(() => Response.json({ error: "not_found" }, { status: 404 }), async (client) => {
      expect(await client.listOrgUsableGatewayProviders("org-a")).toEqual([]);
    });
    await withFetch(() => Response.json({ error: "forbidden" }, { status: 403 }), async (client) => {
      await expect(client.listOrgUsableGatewayProviders("org-a")).rejects.toThrow();
    });
  });
});
