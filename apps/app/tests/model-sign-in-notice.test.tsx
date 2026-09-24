import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { GatewayUsableModel } from "@openwork/types/den/gateway";
import type { ModelRef } from "../src/app/types";

GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => { await GlobalRegistrator.unregister(); });
const { createRoot } = await import("react-dom/client");
const { pendingGatewayModelOptions } = await import("../src/react-app/domains/connections/provider-auth/cloud-provider-config");
const {
  decideFirstChatModel,
  dismissModelSignInNotice,
  modelSignInNoticeDismissKey,
  readDismissedModelSignInNotices,
  useModelSignInNoticeStore,
} = await import("../src/react-app/domains/connections/provider-auth/model-sign-in-notice");
const { GatewayModelAccessProvider } = await import("../src/react-app/domains/connections/provider-auth/gateway-model-access");
const { ModelSignInNotice } = await import("../src/react-app/domains/session/surface/model-sign-in-notice");

const setId = "gcs_00000000000000000000000002";
const gemini: GatewayUsableModel = {
  id: "gwm_00000000000000000000000001_00000000000000000000000002_00000000000000000000000003", name: "Gemini 2.5 Pro",
  config: { id: "gwm_00000000000000000000000001_00000000000000000000000002_00000000000000000000000003" },
  upstreamModelId: "gemini-2.5-pro", modelGroupId: "gmg_00000000000000000000000001", modelGroupName: "Everyone",
  credentialSetId: setId, credentialSetName: "Your Google account",
};
const googleCloud = { cloudProviderId: "ipr_google", providerId: "ipr_google", credentialSetId: setId, name: "Google Cloud", authUrl: null, models: [gemini] };
const pendingOptions = pendingGatewayModelOptions([googleCloud]);
const wanted: ModelRef = { providerID: "ipr_google", modelID: gemini.id };
const sonnet = { providerID: "openwork", modelID: "claude-sonnet-4-5" };
const local = { providerID: "ollama", modelID: "llama3.2" };

afterEach(() => {
  useModelSignInNoticeStore.getState().setNotice(null);
  window.localStorage.clear();
});

test("a default that needs sign-in starts the composer on the first ready OpenWork Models model", () => {
  const decision = decideFirstChatModel({ currentDefault: wanted, wanted: null, pendingOptions, providers: [googleCloud], readyOptions: [local, sonnet] });
  expect(decision).toMatchObject({ kind: "fallback", fallback: sonnet, wanted, modelName: "Gemini 2.5 Pro" });
});

test("without OpenWork Models the fallback is any model that works; with none, nothing changes", () => {
  expect(decideFirstChatModel({ currentDefault: wanted, wanted: null, pendingOptions, providers: [googleCloud], readyOptions: [local] }))
    .toMatchObject({ kind: "fallback", fallback: local });
  expect(decideFirstChatModel({ currentDefault: wanted, wanted: null, pendingOptions, providers: [googleCloud], readyOptions: [] }))
    .toEqual({ kind: "none" });
});

test("a ready default is left alone", () => {
  expect(decideFirstChatModel({ currentDefault: sonnet, wanted: null, pendingOptions, providers: [googleCloud], readyOptions: [sonnet] }))
    .toEqual({ kind: "none" });
});

test("after sign-in the composer switches back to the company's model", () => {
  expect(decideFirstChatModel({ currentDefault: sonnet, wanted, pendingOptions, providers: [googleCloud], readyOptions: [sonnet] }))
    .toEqual({ kind: "none" });
  expect(decideFirstChatModel({ currentDefault: sonnet, wanted, pendingOptions: [], providers: [], readyOptions: [sonnet, wanted] }))
    .toEqual({ kind: "restore", wanted });
  // The engine may still be reloading its catalog; the sign-in is what counts.
  expect(decideFirstChatModel({ currentDefault: sonnet, wanted, pendingOptions: [], providers: [], readyOptions: [sonnet] }))
    .toEqual({ kind: "restore", wanted });
});

test("dismissing is remembered per organization and model", () => {
  const key = modelSignInNoticeDismissKey("org_acme", wanted);
  expect(readDismissedModelSignInNotices().has(key)).toBe(false);
  dismissModelSignInNotice(key);
  expect(readDismissedModelSignInNotices().has(key)).toBe(true);
  expect(readDismissedModelSignInNotices().has(modelSignInNoticeDismissKey("org_other", wanted))).toBe(false);
});

test("the notice says whose default needs which sign-in, signs in in place, and can be dismissed", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let release: (ready: boolean) => void = () => undefined;
  const logins: string[] = [];
  const login = async (provider: typeof googleCloud) => {
    logins.push(provider.cloudProviderId);
    return new Promise<boolean>((resolve) => { release = resolve; });
  };
  useModelSignInNoticeStore.getState().setNotice({
    wanted, modelName: "Gemini 2.5 Pro", organizationName: "Acme Studio", provider: googleCloud,
    dismissKey: modelSignInNoticeDismissKey("org_acme", wanted),
  });
  const button = (text: string) => {
    const found = [...host.querySelectorAll("button")].find((node) => node.textContent === text || node.getAttribute("aria-label") === text);
    if (!found) throw new Error(`Missing ${text}`);
    return found;
  };
  try {
    await act(async () => root.render(
      <GatewayModelAccessProvider providers={[googleCloud]} scopeKey="org/session" login={login}>
        <ModelSignInNotice />
      </GatewayModelAccessProvider>,
    ));
    expect(host.textContent).toContain("Gemini 2.5 Pro, Acme Studio's default, needs your Google sign-in.");
    await act(async () => button("Sign in with Google").click());
    expect(logins).toEqual(["ipr_google"]);
    expect(host.textContent).toContain("Finish signing in in your browser.");
    await act(async () => { release(false); });
    expect(host.textContent).toContain("Sign-in didn't finish.");
    await act(async () => button("Dismiss").click());
    expect(host.textContent).toBe("");
    expect(readDismissedModelSignInNotices().has(modelSignInNoticeDismissKey("org_acme", wanted))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("the picker no longer opens by itself", async () => {
  const source = await Bun.file(new URL("../src/react-app/shell/session-route.tsx", import.meta.url)).text();
  expect(source).not.toContain("autoOpenedUnavailableModelRef");
  expect(source).not.toContain("shouldAutoOpenUnavailableModelPicker");
});
