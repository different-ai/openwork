import { describe, expect, test } from "bun:test";
import {
  connectGatewayProvider,
  type GatewayConnectProvider,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";
import { resyncAfterGatewaySignIn } from "../src/react-app/domains/connections/provider-auth/live-provider-sync";

const provider: GatewayConnectProvider = {
  cloudProviderId: "ipr_01m88mmp6mee19my5q9e2rq8p9",
  credentialSetId: "gcs_01m88mmp6mee19my5q9e2rq8p9",
  providerId: "ipr_01m88mmp6mee19my5q9e2rq8p9",
  name: "LiteLLM / Entra",
  authUrl: null,
};

describe("resync after Gateway sign-in", () => {
  test("live sync confirms the catalog without a verified usage scope, and rereads providers", async () => {
    const calls: string[] = [];
    const synced = await resyncAfterGatewaySignIn({
      runSync: async () => { calls.push("sync"); return { outcome: "handled_live" }; },
      refreshProviders: async () => { calls.push("providers"); },
      gatewayUsageProviderScope: () => null,
    });
    expect(synced).toBe(true);
    expect(calls).toEqual(["sync", "providers"]);
  });

  test("an unhandled run is only synced once the usage scope is verified", async () => {
    let scope: number | null = null;
    const input = {
      runSync: async () => undefined,
      refreshProviders: async () => undefined,
      gatewayUsageProviderScope: () => scope,
    };
    expect(await resyncAfterGatewaySignIn(input)).toBe(false);
    scope = 3;
    expect(await resyncAfterGatewaySignIn(input)).toBe(true);
  });
});

describe("connectGatewayProvider", () => {
  test("rechecks as soon as the app window comes back, before the poll interval", async () => {
    const controller = new AbortController();
    let wake: (() => void) | null = null;
    let resyncs = 0;
    let openedUrl: string | null = null;
    const connected = connectGatewayProvider({
      provider,
      signal: controller.signal,
      startOAuth: async () => ({ authorizationUrl: "https://example.test/authorize" }),
      openUrl: (url) => { openedUrl = url; },
      resync: async () => { resyncs += 1; },
      isConnected: () => resyncs > 0,
      subscribeWake: (next) => {
        wake = next;
        // The person comes back to the app shortly after the browser opened.
        setTimeout(() => wake?.(), 10);
        return () => { wake = null; };
      },
      pollIntervalMs: 60_000,
      attempts: 1,
    });
    const result = await Promise.race([
      connected,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);
    controller.abort();
    expect(openedUrl).toBe("https://example.test/authorize");
    expect(result).toBe(true);
    expect(resyncs).toBe(1);
    expect(wake).toBeNull();
  });

  test("keeps polling until the signed-in model is available", async () => {
    let resyncs = 0;
    const connected = await connectGatewayProvider({
      provider,
      signal: new AbortController().signal,
      startOAuth: async () => ({ authorizationUrl: "https://example.test/authorize" }),
      openUrl: () => undefined,
      resync: async () => { resyncs += 1; },
      isConnected: () => resyncs >= 3,
      wait: async () => undefined,
      attempts: 5,
    });
    expect(connected).toBe(true);
    expect(resyncs).toBe(3);
  });
});
