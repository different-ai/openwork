import { afterEach, describe, expect, test } from "bun:test";

import { cloudEnvironmentOverlay, cloudEnvironmentSnapshot, setCloudEnvironmentOverlay } from "../src/cloud-environment-overlay.js";
import { createV2ProviderSessionBridge } from "../src/opencode-v2-provider-session.js";
import { CloudEnvironmentSync } from "../src/cloud-environment-sync.js";
import type { RolloverOutcome } from "../src/engine-pool.js";

const session = { baseUrl: "https://den.example", token: "token", orgId: "org_1" };

type Variable = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  valueMode: "admin" | "per_member";
  source: "everyone" | "team" | "direct" | "own" | null;
  editable: boolean;
  assignments: Array<{ accessId: string; kind: "everyone" | "team" | "direct"; label: string }>;
  selectedAccessId: string | null;
  value: string | null;
  updatedAt: string;
};

function variable(overrides: Partial<Variable>): Variable {
  return {
    id: "evr_1",
    key: "API_TOKEN",
    name: "API token",
    description: null,
    valueMode: "admin",
    source: "everyone",
    editable: false,
    assignments: [{ accessId: "eva_1", kind: "everyone", label: "Everyone in Acme" }],
    selectedAccessId: "eva_1",
    value: "secret",
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function den(responses: Array<{ status: number; body?: unknown }>) {
  const requests: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    const next = responses.shift() ?? { status: 500 };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  }) as typeof globalThis.fetch;
  return { fetchImpl, requests };
}

function recorder(outcome: RolloverOutcome | null = { action: "rolled_over", generationId: "g", drainingSessions: 0 }) {
  const reloads: Array<Record<string, string>> = [];
  const digests: string[] = [];
  return {
    reloads,
    digests,
    reloadEngine: async (digest: string) => {
      reloads.push({ ...cloudEnvironmentOverlay() });
      digests.push(digest);
      return outcome;
    },
  };
}

afterEach(() => setCloudEnvironmentOverlay({}));

describe("CloudEnvironmentSync", () => {
  test("puts resolved values in the engine overlay and starts a new engine", async () => {
    const { fetchImpl, requests } = den([{ status: 200, body: { environmentVariables: [variable({})] } }]);
    const engine = recorder();
    const sync = new CloudEnvironmentSync({ fetchImpl, reloadEngine: engine.reloadEngine });
    await sync.setSession(session);
    sync.stop();

    expect(requests[0]?.url).toBe("https://den.example/v1/environment-variables/resolved");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer token");
    expect(cloudEnvironmentOverlay()).toEqual({ API_TOKEN: "secret" });
    expect(engine.reloads).toEqual([{ API_TOKEN: "secret" }]);
    // The engine is told which environment to confirm, by fingerprint.
    expect(engine.digests).toEqual([cloudEnvironmentSnapshot().digest]);
    expect(sync.status().applied).toBe(true);
  });

  test("never returns admin-provisioned values, only the member's own", async () => {
    const { fetchImpl } = den([{ status: 200, body: { environmentVariables: [
      variable({}),
      variable({ id: "evr_2", key: "MY_TOKEN", valueMode: "per_member", source: "own", editable: true, assignments: [], selectedAccessId: null, value: "mine" }),
    ] } }]);
    const sync = new CloudEnvironmentSync({ fetchImpl, reloadEngine: recorder().reloadEngine });
    await sync.setSession(session);
    sync.stop();

    const [admin, own] = sync.status().variables;
    expect(admin?.hasValue).toBe(true);
    expect(admin && "value" in admin).toBe(false);
    expect(own?.value).toBe("mine");
  });

  test("leaves out variables without a value", async () => {
    const { fetchImpl } = den([{ status: 200, body: { environmentVariables: [
      variable({ valueMode: "per_member", editable: true, source: null, assignments: [], selectedAccessId: null, value: null }),
    ] } }]);
    const engine = recorder();
    const sync = new CloudEnvironmentSync({ fetchImpl, reloadEngine: engine.reloadEngine });
    await sync.setSession(session);
    sync.stop();

    expect(cloudEnvironmentOverlay()).toEqual({});
    expect(engine.reloads).toEqual([]);
  });

  test("keeps the last values when Den can't be reached", async () => {
    const { fetchImpl } = den([
      { status: 200, body: { environmentVariables: [variable({})] } },
      { status: 503 },
    ]);
    const engine = recorder();
    const sync = new CloudEnvironmentSync({ fetchImpl, reloadEngine: engine.reloadEngine });
    await sync.setSession(session);
    const status = await sync.run("interval");
    sync.stop();

    expect(status.lastRun?.ok).toBe(false);
    expect(cloudEnvironmentOverlay()).toEqual({ API_TOKEN: "secret" });
    expect(engine.reloads).toHaveLength(1);
  });

  test("removes every value when the organization turns the feature off", async () => {
    const { fetchImpl } = den([
      { status: 200, body: { environmentVariables: [variable({})] } },
      { status: 404, body: { error: "feature_disabled" } },
    ]);
    const engine = recorder();
    const sync = new CloudEnvironmentSync({ fetchImpl, reloadEngine: engine.reloadEngine });
    await sync.setSession(session);
    const status = await sync.run("interval");
    sync.stop();

    expect(status.available).toBe(false);
    expect(cloudEnvironmentOverlay()).toEqual({});
    expect(engine.reloads).toEqual([{ API_TOKEN: "secret" }, {}]);
  });

  test("sign-out clears values and starts an engine without them", async () => {
    const { fetchImpl } = den([{ status: 200, body: { environmentVariables: [variable({})] } }]);
    const engine = recorder();
    const sync = new CloudEnvironmentSync({ fetchImpl, reloadEngine: engine.reloadEngine });
    await sync.setSession(session);
    await sync.clearSession();

    expect(cloudEnvironmentOverlay()).toEqual({});
    expect(engine.reloads.at(-1)).toEqual({});
    expect(sync.status().variables).toEqual([]);
  });

  test("never puts keys that make programs run other commands in the engine", async () => {
    const { fetchImpl } = den([{ status: 200, body: { environmentVariables: [
      variable({}),
      variable({ id: "evr_2", key: "GIT_CONFIG_COUNT", value: "1" }),
      variable({ id: "evr_3", key: "LD_PRELOAD", value: "/tmp/x.so" }),
    ] } }]);
    const sync = new CloudEnvironmentSync({ fetchImpl, reloadEngine: recorder().reloadEngine });
    await sync.setSession(session);
    sync.stop();

    expect(cloudEnvironmentOverlay()).toEqual({ API_TOKEN: "secret" });
  });

  test("another account's values are cleared as soon as the session changes", async () => {
    const { fetchImpl } = den([
      { status: 200, body: { environmentVariables: [variable({ key: "OW_PERSONAL", valueMode: "per_member", source: "own", editable: true, assignments: [], selectedAccessId: null, value: "first-person" })] } },
      { status: 503 },
    ]);
    const engine = recorder();
    const sync = new CloudEnvironmentSync({ fetchImpl, reloadEngine: engine.reloadEngine });
    await sync.setSession(session);
    // Same organization, another person: their fetch fails, but nothing of the first person's remains.
    await sync.setSession({ ...session, token: "another-person" });
    sync.stop();

    expect(sync.status().variables).toEqual([]);
    expect(cloudEnvironmentOverlay()).toEqual({});
    // The engine with the first person's value was replaced before the failed fetch.
    expect(engine.reloads).toEqual([{ OW_PERSONAL: "first-person" }, {}]);
  });

  test("retries an engine change the pool could not apply yet", async () => {
    const { fetchImpl } = den([
      { status: 200, body: { environmentVariables: [variable({})] } },
      { status: 200, body: { environmentVariables: [variable({})] } },
    ]);
    let outcome: RolloverOutcome = { action: "coalesced" };
    const reloads: number[] = [];
    const sync = new CloudEnvironmentSync({
      fetchImpl,
      reloadEngine: async () => { reloads.push(1); return outcome; },
    });
    await sync.setSession(session);
    expect(sync.status().applied).toBe(false);
    outcome = { action: "rolled_over", generationId: "g", drainingSessions: 1 };
    await sync.run("interval");
    sync.stop();

    expect(reloads).toHaveLength(2);
    expect(sync.status().applied).toBe(true);
  });
});

describe("v2 session bridge environment", () => {
  test("serves the overlay only with the engine's capability and records what it served", async () => {
    setCloudEnvironmentOverlay({ API_TOKEN: "secret" });
    const bridge = await createV2ProviderSessionBridge(() => null, { environment: cloudEnvironmentSnapshot });
    try {
      const origin = new URL(bridge.url).origin;
      expect((await fetch(`${origin}/environment`)).status).toBe(401);
      expect(bridge.servedEnvironmentDigest()).toBeNull();
      const response = await fetch(`${origin}/environment`, { headers: { authorization: `Bearer ${bridge.token}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ digest: cloudEnvironmentSnapshot().digest, env: { API_TOKEN: "secret" } });
      expect(bridge.servedEnvironmentDigest()).toBe(cloudEnvironmentSnapshot().digest);
    } finally {
      await bridge.close();
    }
  });

  test("has no environment endpoint unless the server provides one", async () => {
    const bridge = await createV2ProviderSessionBridge(() => null);
    try {
      const response = await fetch(`${new URL(bridge.url).origin}/environment`, { headers: { authorization: `Bearer ${bridge.token}` } });
      expect(response.status).toBe(404);
    } finally {
      await bridge.close();
    }
  });
});
