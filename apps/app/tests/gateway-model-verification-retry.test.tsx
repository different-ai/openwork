/** @jsxImportSource react */
import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { GatewayModelLogin } from "../src/react-app/domains/connections/provider-auth/gateway-model-access";
import { GatewayModelVerificationError, type GatewayConnectProvider } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
// Base UI chooses its portal runtime at module initialization.
const { GatewayModelAccessProvider, useGatewayModelSelection } = await import("../src/react-app/domains/connections/provider-auth/gateway-model-access");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});
const provider: GatewayConnectProvider = { cloudProviderId: "ipr_fixture", providerId: "ipr_fixture", name: "Provider", authUrl: null, credentialSetId: "gcs_set",
  models: [{ id: "gwm_group_set_model", name: "Requested model", config: { id: "gwm_group_set_model" }, upstreamModelId: "upstream", modelGroupId: "gmg_group", modelGroupName: "Group", credentialSetId: "gcs_set", credentialSetName: "Set" }] };

test("a failed current catalog keeps the selection uncommitted and offers Refresh models without restarting Login", async () => {
  const commit = mock(() => {});
  const login = mock<GatewayModelLogin>(async (_provider, _signal, _model, options) => {
    if (!options?.verifyOnly) throw new GatewayModelVerificationError();
    return true;
  });
  function Choose() {
    const selection = useGatewayModelSelection("chat");
    return <button onClick={() => {
      const option = selection.options[0];
      if (!option) throw new Error("Missing pending option");
      selection.select(option, commit);
    }}>Choose model</button>;
  }
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const click = async (label: string) => {
    const button = Array.from(document.querySelectorAll("button")).find(candidate => candidate.textContent === label);
    if (!button) throw new Error(`Missing ${label}: ${document.body.innerHTML}`);
    await act(async () => button.click());
  };
  try {
    await act(async () => root.render(<GatewayModelAccessProvider providers={[provider]} scopeKey="account/workspace/chat" login={login}><Choose /></GatewayModelAccessProvider>));
    await click("Choose model");
    await click("Login");
    expect(document.body.textContent).toContain("Couldn't verify the current model list. Refresh models to check again.");
    expect(document.body.textContent).toContain("Verify model access");
    expect(document.body.textContent).not.toContain("Sign-in failed");
    expect(commit).not.toHaveBeenCalled();
    expect(login.mock.calls[0]?.[3]).toEqual({ verifyOnly: false });
    // Auth is now ready, so its pending sign-in row may disappear. The current
    // request must still be verifiable against fresh access, not canceled.
    await act(async () => root.render(<GatewayModelAccessProvider providers={[]} scopeKey="account/workspace/chat" login={login}><Choose /></GatewayModelAccessProvider>));
    await click("Refresh models");
    expect(login.mock.calls[1]?.[3]).toEqual({ verifyOnly: true });
    expect(login).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});
