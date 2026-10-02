/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type {
  DenLibraryAccessGrant,
  DenLibraryItem,
  DenLibraryOrgDirectory,
} from "../src/app/lib/den-library";

GlobalRegistrator.register({ url: "http://localhost/" });
const { createRoot } = await import("react-dom/client");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
notifyManager.setScheduler(queueMicrotask);
const pluginId = "plg_fixture";
let owner = true;
let admin = true;
let grants: DenLibraryAccessGrant[];
let directory: DenLibraryOrgDirectory = {
  currentMemberId: "owner",
  members: [
    { id: "owner", name: "App owner", email: null },
    { id: "teammate", name: "Teammate", email: null },
  ],
  teams: [],
};
const client = {
  listMeLibraryItems: mock(
    async (): Promise<DenLibraryItem[]> => [
      {
        type: "plugin",
        id: pluginId,
        name: "Order calculator",
        description: null,
        componentCount: 1,
        componentKinds: ["app"],
        role: owner ? "owner" : "viewer",
        edges: owner ? [{ kind: "mine" }] : [{ kind: "org_wide" }],
      },
    ],
  ),
  getLibraryOrgDirectory: mock(async () => directory),
  listManagedPluginAccess: mock(async () => new Map([[pluginId, grants]])),
  listPluginAccess: mock(async () => grants),
  grantPluginAccess: mock(
    async (
      _orgId: string,
      _pluginId: string,
      target: { orgWide?: boolean; orgMembershipId?: string; teamId?: string },
    ) => {
      const grant: DenLibraryAccessGrant = {
        id: "new",
        role: "viewer",
        orgMembershipId: target.orgMembershipId ?? null,
        teamId: target.teamId ?? null,
        orgWide: target.orgWide ?? false,
      };
      grants = [...grants, grant];
      return grant;
    },
  ),
  revokePluginAccess: mock(
    async (_orgId: string, _pluginId: string, grantId: string) => {
      grants = grants.filter((grant) => grant.id !== grantId);
    },
  ),
};
mock.module("../src/react-app/domains/apps/use-apps", () => ({
  useAppsClient: () => ({
    client,
    orgId: "org",
    identityVerified: true,
    canManage: admin,
    scope: ["deployment", "principal", "org", "api"],
  }),
}));
const { BuiltAppShareButton } = await import(
  "../src/react-app/domains/apps/built-app-share-button"
);
let container: HTMLDivElement;
let root: Root;
let cache: QueryClient;
beforeEach(async () => {
  owner = true;
  admin = true;
  grants = [
    {
      id: "owner-grant",
      orgMembershipId: "owner",
      teamId: null,
      orgWide: false,
      role: "owner",
    },
    {
      id: "person-grant",
      orgMembershipId: "teammate",
      teamId: null,
      orgWide: false,
      role: "viewer",
    },
  ];
  client.grantPluginAccess.mockClear();
  client.revokePluginAccess.mockClear();
  client.getLibraryOrgDirectory
    .mockReset()
    .mockImplementation(async () => directory);
  cache = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <BuiltAppShareButton pluginId={pluginId} title="Order calculator" />
      </QueryClientProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  cache.clear();
});
afterAll(async () => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  await GlobalRegistrator.unregister();
});
function named(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Missing ${text}`);
  return button;
}
async function open() {
  await act(async () => named("Share").click());
}
test("Share uses the normal audience screen and preserves existing people and owner grants", async () => {
  await open();
  expect(
    document.querySelector('[data-testid="library-share-page"]') !== null ||
      document.body.textContent?.includes("Who can use it"),
  ).toBe(true);
  expect(document.body.textContent).toContain("Teammate");
  const everyone = document.querySelector<HTMLElement>('[role="switch"]');
  expect(everyone !== null).toBe(true);
  await act(async () => everyone?.click());
  await act(async () => named("Share with everyone").click());
  expect(client.grantPluginAccess).toHaveBeenCalledWith("org", pluginId, {
    orgWide: true,
  });
  expect(client.revokePluginAccess).not.toHaveBeenCalled();
  expect(grants.some((grant) => grant.id === "owner-grant")).toBe(true);
  expect(grants.some((grant) => grant.id === "person-grant")).toBe(true);
});
test("a member owner can share with people but does not get the org-wide control", async () => {
  admin = false;
  await open();
  expect(document.body.textContent).toContain("Add person");
  expect(document.querySelector('[role="switch"]') === null).toBe(true);
});
test("viewers cannot change the App's audience", async () => {
  owner = false;
  await open();
  expect(document.body.textContent).toContain(
    "Only this app's owner can share it",
  );
  expect(document.body.textContent?.includes("Add person")).toBe(false);
  expect(client.grantPluginAccess).not.toHaveBeenCalled();
});
test("a directory load failure has a working retry", async () => {
  client.getLibraryOrgDirectory.mockRejectedValueOnce(new Error("offline"));
  await open();
  expect(document.body.textContent).toContain("Sharing could not be loaded");
  await act(async () => named("Try again").click());
  expect(document.body.textContent).toContain("Who can use it");
});
