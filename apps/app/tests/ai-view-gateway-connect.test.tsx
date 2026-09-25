/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  connectGatewayProvider,
  GATEWAY_CONNECT_POLL_ATTEMPTS,
  GATEWAY_CONNECT_POLL_INTERVAL_MS,
  GATEWAY_CONNECT_TIMEOUT_MESSAGE,
  type GatewayConnectProvider,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";
import { GatewayConnectRow } from "../src/react-app/domains/settings/pages/ai-view";

const provider: GatewayConnectProvider = {
  cloudProviderId: "ipr_member",
  providerId: "ipr_member",
  name: "Member Vertex",
  authUrl: "https://den.example.test/v1/inference-providers/ipr_member/oauth/start",
};

test("Settings > AI providers renders a skipped member_auth_required gateway provider as a Connect row", () => {
  const html = renderToStaticMarkup(<GatewayConnectRow provider={provider} busy={false} onConnect={() => undefined} />);
  expect(html).toContain("Member Vertex");
  expect(html).toContain("via OpenWork Gateway");
  expect(html).toContain("Sign in to Member Vertex to use it");
  expect(html).toContain("Login");
  expect(html).not.toContain('disabled=""');

  const noUrl = renderToStaticMarkup(
    <GatewayConnectRow provider={{ ...provider, authUrl: null }} busy={false} onConnect={() => undefined} />,
  );
  expect(noUrl).not.toContain('disabled=""');
});

test("clicking Connect uses authenticated OAuth rather than the supplied authUrl and re-syncs cloud providers", async () => {
  const registeredDom = typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined";
  if (registeredDom) GlobalRegistrator.register();
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const opened: string[] = [];
  let syncs = 0;
  let done: Promise<boolean> | null = null;
  try {
    await act(async () => root.render(
      <GatewayConnectRow
        provider={provider}
        busy={false}
        onConnect={(target) => {
          done = connectGatewayProvider({
            provider: target,
            signal: new AbortController().signal,
            startOAuth: async (id) => {
              expect(id).toBe(provider.cloudProviderId);
              return { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture" };
            },
            openUrl: (url) => { opened.push(url); },
            resync: async () => { syncs += 1; },
            isConnected: () => syncs > 0,
            wait: async () => undefined,
          });
        }}
      />,
    ));
    const button = container.querySelector<HTMLButtonElement>("button");
    if (!button) throw new Error("Expected the Connect button");
    expect(button.textContent).toContain("Login");
    await act(async () => button.click());
    expect(await done).toBe(true);
    expect(opened).toEqual(["https://accounts.google.com/o/oauth2/v2/auth?state=fixture"]);
    expect(opened).not.toContain(provider.authUrl);
    expect(syncs).toBe(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});

test("canceling Connect while waiting cancels its timer and prevents further syncs", async () => {
  const controller = new AbortController();
  let syncs = 0;
  const pending = connectGatewayProvider({
    provider, signal: controller.signal,
    startOAuth: async () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" }),
    openUrl: () => { controller.abort(); },
    resync: async () => { syncs += 1; }, isConnected: () => false,
    pollIntervalMs: 60_000,
  });
  expect(await pending).toBe(false);
  expect(syncs).toBe(0);
});

test("Connect polling stops at the bound without claiming a missing provider is connected", async () => {
  let syncs = 0;
  expect(await connectGatewayProvider({
    provider, signal: new AbortController().signal,
    startOAuth: async () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" }),
    openUrl: () => undefined, resync: async () => { syncs += 1; },
    isConnected: () => false, wait: async () => undefined, attempts: 3,
  })).toBe(false);
  expect(syncs).toBe(3);
});

test("waits up to the ten-minute consent window and offers actionable timeout copy", () => {
  expect(GATEWAY_CONNECT_POLL_ATTEMPTS * GATEWAY_CONNECT_POLL_INTERVAL_MS).toBe(600_000);
  expect(GATEWAY_CONNECT_TIMEOUT_MESSAGE).toContain("not been confirmed");
  expect(GATEWAY_CONNECT_TIMEOUT_MESSAGE).toContain("retry sign-in");
  const html = renderToStaticMarkup(<GatewayConnectRow provider={provider} busy onConnect={() => undefined} onCancel={() => undefined} />);
  expect(html).toContain("Stop waiting");
});

test("an account switch during OAuth start never opens the old account's browser URL", async () => {
  const controller = new AbortController();
  const opened: string[] = [];
  let syncs = 0;
  const result = await connectGatewayProvider({
    provider: { ...provider, credentialSetId: "gcs_selected" }, signal: controller.signal,
    startOAuth: async (id, set, signal) => {
      expect(id).toBe(provider.cloudProviderId);
      expect(set).toBe("gcs_selected");
      expect(signal).toBe(controller.signal);
      controller.abort();
      return { authorizationUrl: "https://den.example.test/gateway/connect?attempt=fixture" };
    },
    openUrl: (url) => { opened.push(url); }, resync: async () => { syncs += 1; },
    isConnected: () => true, wait: async () => undefined,
  });
  expect(result).toBe(false);
  expect(opened).toEqual([]);
  expect(syncs).toBe(0);
});

test("cancellation during a status read cannot report success from the next account's inventory", async () => {
  const controller = new AbortController();
  let checked = false;
  expect(await connectGatewayProvider({
    provider, signal: controller.signal,
    startOAuth: async () => ({ authorizationUrl: "https://den.example.test/gateway/connect?attempt=fixture" }),
    openUrl: () => undefined, resync: async () => { controller.abort(); },
    isConnected: () => { checked = true; return true; }, wait: async () => undefined,
  })).toBe(false);
  expect(checked).toBe(false);
});

test("consent completing after the old one-minute window is picked up; temporary read failure can recover", async () => {
  let syncs = 0;
  expect(await connectGatewayProvider({
    provider, signal: new AbortController().signal,
    startOAuth: async () => ({ authorizationUrl: "https://den.example.test/gateway/connect?attempt=fixture" }),
    openUrl: () => undefined,
    resync: async () => { syncs += 1; if (syncs === 1) throw new Error("Temporary status failure"); },
    isConnected: () => syncs === 8, wait: async () => undefined,
  })).toBe(true);
  expect(syncs).toBe(8);
});
