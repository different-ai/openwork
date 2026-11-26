/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  gatewayConnectProviderKey,
  resolveLiveGatewayConnectProviders,
  resolveLiveGatewayImportedProviders,
  type LiveGatewayProvider,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";
import { credentialHealthKey, useProviderCredentialHealth } from "../src/react-app/domains/connections/provider-auth/credential-health";
import { CloudSessionProvider, useCloudSession } from "../src/react-app/domains/settings/cloud/cloud-session-provider";
import { CloudProvidersView, type CloudProvidersViewProps } from "../src/react-app/domains/settings/pages/cloud-providers-view";
import { cleanProviderSlug, formatGatewayModelPreview } from "../src/react-app/domains/settings/pages/provider-rows";

const workspaceId = "workspace-gateway-ui";
const providerId = "ipr_01m292yddve0pbd5rnb30rk3ap";
const groupId = "gmg_01m292yddve0pbd5rnb30rk3aq";
const sharedSet = "gcs_01m292ydevejz88xgn8dhsdy22";
const personalSet = "gcs_01m292yde8escv5k6jkfwq8y1n";

function model(name: string, suffix: string, credentialSetId = sharedSet): LiveGatewayProvider["models"][number] {
  const id = `gwm_${groupId.slice(4)}_${credentialSetId.slice(4)}_${suffix}`;
  return {
    id,
    name,
    config: { id },
    upstreamModelId: suffix,
    modelGroupId: groupId,
    modelGroupName: "Default",
    credentialSetId,
    credentialSetName: credentialSetId === sharedSet ? "Shared" : "Personal",
  };
}

const openAI: LiveGatewayProvider = {
  id: providerId,
  providerId: "openai",
  name: "OW OpenAI",
  credentialStatus: "ready",
  updatedAt: "2026-10-28T00:00:00.000Z",
  models: [
    model("GPT-6.2 Sol", "sol"),
    model("GPT-6.3", "new"),
    model("GPT-6.2 Astra", "astra"),
    model("GPT-6.2 Spark", "spark"),
  ],
  authorizationRequests: [],
};
const missing: LiveGatewayProvider = {
  ...openAI,
  providerId: "litellm",
  name: "Team LiteLLM",
  credentialStatus: "org_credential_missing",
  models: [],
};
const organization = { id: "org-fixture", name: "Example team", slug: "example-team", role: "member" } satisfies NonNullable<ReturnType<typeof useCloudSession>["activeOrganization"]>;
const defaults: CloudProvidersViewProps = {
  runtimeWorkspaceId: workspaceId,
  checkDesktopAppRestriction: () => false,
  cloudOrgProviders: [],
  connectCloudProvider: async () => {},
  embedded: true,
  importedCloudProviders: {},
  importsUnavailable: false,
  lastSyncError: {},
  openworkServerAvailable: true,
  onOpenAccount: () => {},
  refreshCloudOrgProviders: async () => [],
  runCloudProviderSync: async () => {},
  serverSync: null,
};

let root: Root;
let host: HTMLDivElement;
let ownedDom: boolean;
let previousAct: unknown;
beforeEach(() => {
  ownedDom = !GlobalRegistrator.isRegistered;
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function SignedIn({ children }: { children: ReactNode }) {
  const { setIsSignedIn, setActiveOrganization } = useCloudSession();
  useEffect(() => {
    setIsSignedIn(true);
    setActiveOrganization(organization);
  }, [setActiveOrganization, setIsSignedIn]);
  return children;
}

async function renderProviders(providers: LiveGatewayProvider[] | null, overrides: Partial<CloudProvidersViewProps> = {}) {
  await act(async () => {
    root.render(<CloudSessionProvider><SignedIn><CloudProvidersView
      {...defaults}
      importedCloudProviders={resolveLiveGatewayImportedProviders(providers ?? [])}
      gatewayConnectProviders={resolveLiveGatewayConnectProviders(providers ?? [])}
      liveGatewayProviders={providers}
      {...overrides}
    /></SignedIn></CloudSessionProvider>);
  });
  return [...host.querySelectorAll('[data-provider-scope="organization"]')];
}

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((entry) => entry.textContent === label);
  if (!found) throw new Error(`No button named ${label}`);
  return found;
}

test("provider metadata uses only public slugs and compact human model names", () => {
  expect(cleanProviderSlug("  Google-Vertex ")).toBe("google-vertex");
  for (const id of [null, undefined, "  ", providerId, " LPR_01m292yddve0pbd5rnb30rk3ap ", "AA922C83-36D3-4878-97FC-5AB606219B4A"]) {
    expect(cleanProviderSlug(id)).toBeUndefined();
  }
  expect(formatGatewayModelPreview([" Sol", "Astra  ", "Sol", "", "GWM_42", "Nova"])).toBe("Astra, Nova +1");
  expect(formatGatewayModelPreview(["Sol", "Astra"])).toBe("Astra, Sol");
  expect(formatGatewayModelPreview([" Astra "])).toBe("Astra");
  expect(formatGatewayModelPreview(["gwm_123", " "])).toBeNull();
});

test("live OpenAI shows brand and models even when legacy imports fail", async () => {
  const [row] = await renderProviders([openAI], {
    importsUnavailable: true,
    liveGatewaySyncedAt: Date.now(),
    serverSync: {
      reloadPending: true,
      skippedProviders: {},
      lastRun: { at: Date.now(), status: "failed" },
    },
  });
  expect(row.textContent).toContain("OW OpenAI");
  expect(row.textContent).toContain("Ready to use");
  expect(row.textContent).not.toContain("Not checked yet");
  expect(row.querySelector(".font-mono")?.textContent).toBe("openai");
  expect(row.textContent).toContain("AI Gateway");
  expect(row.textContent).toContain("GPT-6.2 Astra, GPT-6.2 Sol +2");
  expect(row.querySelector(".tabular-nums")?.textContent).toBe("4 models");
  expect(row.querySelector('svg[role="img"] path')?.getAttribute("d")).toStartWith("M22.28 9.82");
  expect(host.textContent).toContain("Synced with Den");
  expect(host.textContent).not.toContain("Not synced with Den yet");
  expect(host.textContent).not.toMatch(/ipr_|gwm_/i);
});

test("ready and personal Bedrock rows precede admin-blocked providers without double-counting", async () => {
  const mixed: LiveGatewayProvider = {
    ...openAI,
    name: "Bedrock",
    providerId: "amazon-bedrock",
    models: [model("Shared Sonnet", "shared")],
    authorizationRequests: [{ credentialSetId: personalSet, name: "Personal", authUrl: "https://den.example.test/auth", models: [model("Personal Sonnet", "personal", personalSet)] }],
  };
  const onConnectGatewayProvider = mock(() => {});
  const rows = await renderProviders([mixed, { ...missing, id: "ipr_waiting" }], { onConnectGatewayProvider });
  expect(rows).toHaveLength(3);
  expect(rows[0].textContent).toContain("Ready to use");
  expect(rows[0].textContent).toContain("Shared Sonnet");
  expect(rows[1].textContent).toContain("Bedrock / Personal");
  expect(rows[1].textContent).toContain("Needs your sign-in");
  expect(rows[1].textContent).toContain("Personal Sonnet");
  expect(rows[1].querySelector(".tabular-nums")?.textContent).toBe("1 model");
  expect(rows[2].textContent).toContain("Needs organization credential");
  expect(host.textContent).toContain("2 providers, 1 credential");
  const signIn = button("Sign in");
  expect(rows[1].contains(signIn)).toBe(true);
  expect(signIn.getAttribute("aria-label")).toBe("Sign in to Bedrock / Personal");
  await act(async () => signIn.click());
  expect(onConnectGatewayProvider).toHaveBeenCalledWith(resolveLiveGatewayConnectProviders([mixed])[0]);
});

test("a granted provider that needs admin setup is shown in both live and legacy sync", async () => {
  const legacy: NonNullable<CloudProvidersViewProps["serverSync"]> = {
    reloadPending: false,
    skippedProviders: {
      [providerId]: { cloudProviderId: providerId, providerId, sourceProviderId: missing.providerId, name: missing.name, reason: "missing_credentials" },
    },
  };
  for (const catalog of [[missing], null]) {
    const [row] = await renderProviders(catalog, { serverSync: legacy });
    expect(row.textContent).toContain("Team LiteLLM");
    expect(row.textContent).toContain("Needs organization credential");
    expect(row.textContent).toContain("Waiting on admin setup");
    expect(row.querySelector(".font-mono")?.textContent).toBe("litellm");
    expect(row.textContent).not.toContain(providerId);
    expect(row.querySelector("button")).toBeNull();
  }
  expect(await renderProviders([], { serverSync: legacy })).toHaveLength(0);
});

test("a busy Google Vertex sign-in uses the Gemini logo and can stop waiting", async () => {
  const [pending] = resolveLiveGatewayConnectProviders([{
    ...missing, name: "Vertex", providerId: "google-vertex", credentialStatus: "member_auth_required",
  }]);
  const onCancelGatewayConnect = mock(() => {});
  const [row] = await renderProviders(null, {
    gatewayConnectProviders: [pending],
    connectingGatewayProviderId: gatewayConnectProviderKey(pending),
    onConnectGatewayProvider: () => {},
    onCancelGatewayConnect,
  });
  expect(row.querySelector("img")?.getAttribute("src")).toContain("googlegemini");
  expect(row.textContent).not.toContain("IP");
  expect(row.querySelector(".font-mono")?.textContent).toBe("google-vertex");
  expect(button("Waiting for sign-in…").disabled).toBe(true);
  await act(async () => button("Stop waiting").click());
  expect(onCancelGatewayConnect).toHaveBeenCalledTimes(1);
});

test("a recorded Gateway credential rejection takes priority over available models", async () => {
  const state = useProviderCredentialHealth.getState();
  const key = credentialHealthKey(workspaceId, providerId);
  useProviderCredentialHealth.setState({ entries: { ...state.entries, [key]: { status: "rejected", revision: 0, observedAt: 0 } } });
  try {
    const [row] = await renderProviders([openAI]);
    expect(row.textContent).toContain("Key not accepted");
    expect(row.textContent).toContain("Contact your admin");
    expect(row.textContent).not.toContain("Ready to use");
  } finally {
    await act(async () => useProviderCredentialHealth.setState({ entries: state.entries }));
  }
});

test("Sync now forces Den org provider refresh and runs Gateway sync", async () => {
  const refreshCloudOrgProviders = mock(async (_options?: { force?: boolean }) => []);
  const runCloudProviderSync = mock(async (_reason: "manual") => {});
  await renderProviders([openAI], { refreshCloudOrgProviders, runCloudProviderSync });
  refreshCloudOrgProviders.mockClear();
  await act(async () => button("Sync now").click());
  expect(refreshCloudOrgProviders).toHaveBeenCalledWith({ force: true });
  expect(runCloudProviderSync).toHaveBeenCalledWith("manual");
});
