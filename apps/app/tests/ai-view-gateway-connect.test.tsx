/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  connectGatewayProvider,
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
  expect(html).toContain("Connect");
  expect(html).not.toContain('disabled=""');

  const noUrl = renderToStaticMarkup(
    <GatewayConnectRow provider={{ ...provider, authUrl: null }} busy={false} onConnect={() => undefined} />,
  );
  expect(noUrl).toContain('disabled=""');
});

test("clicking Connect opens authUrl in the browser and re-syncs cloud providers", async () => {
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
    expect(button.textContent).toContain("Connect");
    await act(async () => button.click());
    expect(await done).toBe(true);
    expect(opened).toEqual([provider.authUrl]);
    expect(syncs).toBe(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    if (registeredDom) await GlobalRegistrator.unregister();
  }
});
