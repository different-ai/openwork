/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createDenClient } = await import("../src/app/lib/den");
const { BuiltAppPublicSharing } = await import("../src/react-app/domains/apps/built-app-public-sharing");
const { BuiltAppShareDialog } = await import("../src/react-app/domains/apps/built-app-share-button");
const appsClient = await import("../src/react-app/domains/apps/use-apps");

const appId = "cob_artifact";
const orgId = "org_artifacts";
const publicUrl = "https://den.example.test/artifacts/shared-link";
const client = createDenClient({ baseUrl: "https://den.example.test", apiBaseUrl: "https://api.example.test", token: "fixture" });
let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  queryClient.clear();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function settleQuery() {
  await act(async () => { await Bun.sleep(10); });
}

async function render() {
  await act(async () => root.render(
    <QueryClientProvider client={queryClient}>
      <BuiltAppPublicSharing client={client} orgId={orgId} appId={appId} />
    </QueryClientProvider>,
  ));
  await settleQuery();
}

function button(label: string) {
  const element = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

async function click(label: string) {
  await act(async () => button(label).click());
  await settleQuery();
}

test("a public link is published explicitly using the artifact ID and checked revision, copied, and turned off", async () => {
  const states = [
    { revisionId: "cov_original", publicUrl: null, canPublish: true },
    { revisionId: "cov_public", publicUrl, canPublish: true },
    { revisionId: "cov_private", publicUrl: null, canPublish: true },
  ];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(states.shift()));
  const copy = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  try {
    await render();
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(host.textContent).toContain("won’t use connected tools or fetch live data");
    expect(host.textContent).toContain("Public link is off");
    await click("Publish public link");
    expect(host.textContent).toContain(publicUrl);
    expect(host.textContent).toContain("works as an MCP endpoint");
    await click("Copy link");
    expect(copy).toHaveBeenCalledWith(publicUrl);
    expect(host.textContent).toContain("Link copied");
    await click("Turn off public link");
    expect(host.textContent).not.toContain(publicUrl);
    expect(host.textContent).toContain("Public link is off");
    expect(fetchMock.mock.calls.map(([url, options]) => ({
      url,
      org: new Headers(options?.headers).get("x-openwork-org-id"),
      method: options?.method,
      body: options?.body,
    }))).toEqual([
      { url: `https://api.example.test/v1/mcp-apps/${appId}/public-sharing`, org: orgId, method: "GET", body: undefined },
      { url: `https://api.example.test/v1/mcp-apps/${appId}/public-sharing`, org: orgId, method: "PUT", body: JSON.stringify({ public: true, expectedRevisionId: "cov_original" }) },
      { url: `https://api.example.test/v1/mcp-apps/${appId}/public-sharing`, org: orgId, method: "PUT", body: JSON.stringify({ public: false, expectedRevisionId: "cov_public" }) },
    ]);
  } finally {
    fetchMock.mockRestore();
    copy.mockRestore();
  }
});

test("stale publishing state is rechecked rather than retrying the write, and tools prevent publishing", async () => {
  const responses = [
    Response.json({ revisionId: "cov_original", publicUrl: null, canPublish: true }),
    Response.json({ error: "revision_conflict" }, { status: 409 }),
    Response.json({ revisionId: "cov_latest", publicUrl: null, canPublish: false }),
  ];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  });
  try {
    await render();
    await click("Publish public link");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("This artifact changed");
    await click("Check public link");
    expect(host.textContent).toContain("This artifact uses connected tools");
    expect(button("Publish public link").disabled).toBe(true);
    expect(fetchMock.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "PUT", "GET"]);
  } finally {
    fetchMock.mockRestore();
  }
});

test("the share dialog retains organization sharing and does not carry a public URL across identity scopes", async () => {
  let scope = ["https://den.example.test", "member_1", orgId, "https://api.example.test"];
  const context = spyOn(appsClient, "useAppsClient").mockImplementation(() => ({
    client, orgId, scope, identityVerified: true, canManage: false, orgName: "Artifacts",
  }));
  const features = spyOn(client, "getOrgFeatures").mockResolvedValue({});
  const list = spyOn(client, "listMeLibraryItems").mockResolvedValue([]);
  const directory = spyOn(client, "getLibraryOrgDirectory").mockResolvedValue({ members: [], teams: [], currentMemberId: null });
  const grants = spyOn(client, "listManagedPluginAccess").mockResolvedValue(new Map());
  const state = spyOn(client, "getBuiltMcpAppPublicSharing").mockResolvedValueOnce({ revisionId: "cov_public", publicUrl, canPublish: true }).mockResolvedValue({ revisionId: "cov_private", publicUrl: null, canPublish: true });
  const renderDialog = async (open: boolean) => {
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <BuiltAppShareDialog appId={appId} pluginId="plg_separate" title="Inventory" open={open} onOpenChange={() => {}} />
      </QueryClientProvider>,
    ));
    await settleQuery();
  };
  try {
    await renderDialog(false);
    expect(state).not.toHaveBeenCalled();
    await renderDialog(true);
    expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(["Within your organization", "Public link"]);
    expect(state).toHaveBeenCalledWith(orgId, appId);
    expect(document.body.textContent).toContain(publicUrl);
    scope = scope.map((part, index) => index === 1 ? "member_2" : part);
    await renderDialog(true);
    expect(state).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(publicUrl);
  } finally {
    await renderDialog(false);
    queryClient.clear();
    context.mockRestore();
    features.mockRestore();
    list.mockRestore();
    directory.mockRestore();
    grants.mockRestore();
    state.mockRestore();
  }
});

test("access denials do not display a URL or offer a publish action", async () => {
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ error: "artifact_not_found" }, { status: 404 }));
  try {
    await render();
    expect(host.textContent).toContain("ask someone who manages this artifact");
    expect(host.querySelector("button")).toBeNull();
  } finally {
    fetchMock.mockRestore();
  }
});
