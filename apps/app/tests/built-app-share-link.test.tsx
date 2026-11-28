import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DenClient } from "../src/app/lib/den";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const den = await import("../src/app/lib/den");
const { BuiltAppShareDialog } = await import("../src/react-app/domains/apps/built-app-share-button");
const appsClient = await import("../src/react-app/domains/apps/use-apps");

const appId = "cob_artifact";
const pluginId = "plg_separate";
const orgId = "org_artifacts";
const baseUrl = "https://den.example.test";
const apiBaseUrl = "https://api.example.test";
const shareUrl = `${baseUrl}/artifact?id=${appId}&org=${orgId}`;
const heading = "Link for your organization";
let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
const restoreMocks: (() => void)[] = [];

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
  for (const restore of restoreMocks.splice(0).reverse()) restore();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function settleQuery() {
  await act(async () => { await Bun.sleep(10); });
}

function setup({ enabled = true, owner = true, response = () => Response.json({ url: shareUrl }) }: {
  enabled?: boolean | ((memberId: string) => boolean);
  owner?: boolean;
  response?: () => Response;
} = {}) {
  let activeOrgId = orgId;
  let memberId = "member_1";
  let client = den.createDenClient({ baseUrl, apiBaseUrl, token: memberId });
  function stubSharing(current: DenClient) {
    const publicSharing = spyOn(current, "getBuiltMcpAppPublicSharing").mockResolvedValue({ revisionId: "cov_private", publicUrl: null, canPublish: owner, blockedBy: null });
    const items = spyOn(current, "listMeLibraryItems").mockResolvedValue([{
      id: pluginId, type: "plugin", name: "Inventory", description: null, componentKinds: [], componentCount: 0,
      role: owner ? "owner" : "viewer", edges: owner ? [{ kind: "mine" }] : [{ kind: "org_wide" }],
    }]);
    const directory = spyOn(current, "getLibraryOrgDirectory").mockResolvedValue({ members: [], teams: [], currentMemberId: null });
    const grants = spyOn(current, "listManagedPluginAccess").mockResolvedValue(new Map([[pluginId, []]]));
    restoreMocks.push(() => publicSharing.mockRestore(), () => items.mockRestore(), () => directory.mockRestore(), () => grants.mockRestore());
  }
  stubSharing(client);
  const context = spyOn(appsClient, "useAppsClient").mockImplementation(() => ({
    client, orgId: activeOrgId, scope: [baseUrl, memberId, activeOrgId, apiBaseUrl], identityVerified: true, canManage: false, orgName: "Artifacts",
  }));
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).endsWith("/v1/org")) {
      return Response.json({ features: { artifactShareLinks: typeof enabled === "function" ? enabled(memberId) : enabled } });
    }
    if (url === `${apiBaseUrl}/v1/mcp-apps/${appId}/share-link`) return response();
    throw new Error(`Unexpected request: ${url}`);
  });
  const copy = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const usage = spyOn(den, "markFeatureUsed").mockImplementation(() => {});
  restoreMocks.push(() => context.mockRestore(), () => fetchMock.mockRestore(), () => copy.mockRestore(), () => usage.mockRestore());
  return {
    copy,
    usage,
    linkRequests: () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/share-link")),
    async render() {
      await act(async () => root.render(
        <QueryClientProvider client={queryClient}>
          <BuiltAppShareDialog appId={appId} pluginId={pluginId} title="Inventory" open={true} onOpenChange={() => {}} />
        </QueryClientProvider>,
      ));
      await settleQuery();
      await settleQuery();
    },
    switchScope(nextMemberId: string, nextOrgId: string) {
      activeOrgId = nextOrgId;
      memberId = nextMemberId;
      client = den.createDenClient({ baseUrl, apiBaseUrl, token: memberId });
      stubSharing(client);
    },
  };
}

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
  await settleQuery();
}

test("an off feature leaves the organization audience editor unchanged without requesting the link", async () => {
  const dialog = setup({ enabled: false });
  await dialog.render();
  expect(document.body.textContent).not.toContain(heading);
  expect(document.querySelector('[aria-label="Checking the organization link"]')).toBeNull();
  expect(document.querySelector('[data-testid="library-share-page"]')).not.toBeNull();
  expect(dialog.linkRequests()).toHaveLength(0);
});

test("copying the organization's link writes exactly the server URL and marks the feature used", async () => {
  const dialog = setup();
  await dialog.render();
  const linkHeading = [...document.querySelectorAll("h3")].find((element) => element.textContent === heading);
  expect(linkHeading?.closest('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(document.querySelector('[role="tab"]')?.id);
  expect(document.body.textContent).toContain(shareUrl);
  expect(dialog.usage).not.toHaveBeenCalled();
  expect(dialog.linkRequests().map(([url, options]) => ({
    url,
    method: options?.method,
    cache: options?.cache,
    org: new Headers(options?.headers).get("x-openwork-org-id"),
  }))).toEqual([{ url: `${apiBaseUrl}/v1/mcp-apps/${appId}/share-link`, method: "GET", cache: "no-store", org: orgId }]);
  await click("Copy link");
  expect(dialog.copy.mock.calls).toEqual([[shareUrl]]);
  expect(dialog.usage.mock.calls).toEqual([["artifactShareLinks"]]);
  expect(document.body.textContent).toContain("Link copied.");
});

for (const error of ["mcp_app_not_found", "feature_disabled"]) {
  test(`${error} hides the link section without hiding the audience editor`, async () => {
    const dialog = setup({ response: () => Response.json({ error }, { status: 404 }) });
    await dialog.render();
    expect(dialog.linkRequests()).toHaveLength(1);
    expect(document.body.textContent).not.toContain(heading);
    expect(document.body.textContent).not.toContain("Try again");
    expect(document.querySelector('[data-testid="library-share-page"]')).not.toBeNull();
  });
}

test("a network error shows a retry action that fetches the link again", async () => {
  let offline = true;
  const dialog = setup({ response: () => {
    if (offline) throw new TypeError("Network failed");
    return Response.json({ url: shareUrl });
  } });
  await dialog.render();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Could not check the organization link. Try again.");
  expect(dialog.linkRequests()).toHaveLength(1);
  offline = false;
  await click("Try again");
  expect(dialog.linkRequests()).toHaveLength(2);
  expect(document.body.textContent).toContain(shareUrl);
});

test("a non-owner can see the link without access to the audience editor", async () => {
  const dialog = setup({ owner: false });
  await dialog.render();
  expect(document.body.textContent).toContain(shareUrl);
  expect(document.body.textContent).toContain("Ask them for access.");
  expect(document.querySelector('[data-testid="library-share-page"]')).toBeNull();
});

test("the feature decision does not carry over to another member of the same organization", async () => {
  const dialog = setup({ enabled: (memberId) => memberId === "member_1" });
  await dialog.render();
  expect(document.body.textContent).toContain(shareUrl);
  dialog.switchScope("member_2", orgId);
  await dialog.render();
  expect(document.body.textContent).not.toContain(shareUrl);
  expect(dialog.linkRequests()).toHaveLength(1);
});

test("an invalid link is not shown", async () => {
  const dialog = setup({ response: () => Response.json({ url: "/artifact" }) });
  await dialog.render();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Could not check the organization link. Try again.");
  expect(document.body.textContent).not.toContain(heading);
});

test("the URL does not carry over when the member or organization changes", async () => {
  const nextOrgId = "org_other";
  const otherOrgUrl = `${baseUrl}/artifact?id=${appId}&org=${nextOrgId}`;
  const responses = [Response.json({ url: shareUrl }), Response.json({ error: "mcp_app_not_found" }, { status: 404 }), Response.json({ url: otherOrgUrl })];
  const dialog = setup({ response: () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  } });
  await dialog.render();
  expect(document.body.textContent).toContain(shareUrl);
  dialog.switchScope("member_2", orgId);
  await dialog.render();
  expect(document.body.textContent).not.toContain(shareUrl);
  dialog.switchScope("member_2", nextOrgId);
  await dialog.render();
  expect(document.body.textContent).toContain(otherOrgUrl);
  expect(document.body.textContent).not.toContain(shareUrl);
  expect(dialog.linkRequests().map(([, options]) => {
    const headers = new Headers(options?.headers);
    return [headers.get("authorization"), headers.get("x-openwork-org-id")];
  })).toEqual([["Bearer member_1", orgId], ["Bearer member_2", orgId], ["Bearer member_2", nextOrgId]]);
});
