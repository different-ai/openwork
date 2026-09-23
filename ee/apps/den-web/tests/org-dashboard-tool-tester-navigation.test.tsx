import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import * as navigation from "next/navigation";
import * as requests from "../app/(den)/_lib/den-flow";
import { parseOrgContextPayload, parseOrgListPayload } from "../app/(den)/_lib/den-org";
import { EMPTY_RUNTIME_CONFIG } from "../app/(den)/_lib/runtime-config";
import * as flow from "../app/(den)/_providers/den-flow-provider";
import * as organization from "../app/(den)/dashboard/_providers/org-dashboard-provider";
import * as palette from "../app/(den)/dashboard/_components/command-palette/den-command-palette";
import { OrgDashboardShell } from "../app/(den)/dashboard/_components/org-dashboard-shell";

const testerHref = "/dashboard/tool-tester";
const generalHref = "/dashboard/org-settings";

function unexpectedAction(): never {
  throw new Error("Navigation tests must not invoke provider actions or network requests");
}

function denFlowFixture(): ReturnType<typeof flow.useDenFlow> {
  return {
    authMode: "sign-in", setAuthMode: unexpectedAction,
    email: "member@example.test", setEmail: unexpectedAction,
    authName: "Test Member", setAuthName: unexpectedAction,
    password: "", setPassword: unexpectedAction,
    verificationCode: "", setVerificationCode: unexpectedAction,
    verificationRequired: false, authBusy: false, authInfo: "", authError: null,
    signupPasswordFeedback: [],
    user: { id: "user-one", email: "member@example.test", name: "Test Member", authProviders: [] },
    sessionHydrated: true, desktopAuthRequested: false, desktopAuthScheme: "openwork",
    setupPending: false, setupOrganizationId: null,
    continueSetup: unexpectedAction, completeSetup: unexpectedAction,
    webAuthRequested: false, desktopRedirectUrl: null, desktopRedirectBusy: false,
    retryDesktopAuthHandoff: unexpectedAction, showAuthFeedback: false,
    submitAuth: unexpectedAction, submitVerificationCode: unexpectedAction,
    resendVerificationCode: unexpectedAction, cancelVerification: unexpectedAction,
    beginSocialAuth: unexpectedAction, signOut: unexpectedAction,
    updateUserProfile: unexpectedAction, resolveUserLandingRoute: unexpectedAction,
    billingSummary: null, billingBusy: false, billingError: null, orgLimitError: null,
    clearOrgLimitError: unexpectedAction, refreshBilling: unexpectedAction,
    onboardingPending: false, onboardingDecisionBusy: false,
    workers: [], filteredWorkers: [], workersBusy: false, workersLoadedOnce: true,
    workersError: null, workerQuery: "", setWorkerQuery: unexpectedAction,
    workerStatusFilter: "all", setWorkerStatusFilter: unexpectedAction,
    selectedWorker: null, activeWorker: null, selectWorker: unexpectedAction,
    workerName: "", setWorkerName: unexpectedAction,
    launchBusy: false, launchStatus: "", launchError: null, actionBusy: null,
    deleteBusyWorkerId: null, redeployBusyWorkerId: null, renameBusyWorkerId: null,
    runtimeSnapshot: null, runtimeBusy: false, runtimeError: null, runtimeUpgradeBusy: false,
    copiedField: null, events: [],
    runtimeConfig: {
      ...EMPTY_RUNTIME_CONFIG, orgMode: "multi_org",
      denApiUrl: "https://api.example.test",
      openworkAppConnectUrl: "https://app.example.test/connect",
      openworkWebUrl: "https://web.example.test",
      openworkAuthCallbackUrl: "https://app.example.test/auth/callback",
    },
    runtimeConfigLoaded: true, openworkDeepLink: null, openworkAppConnectUrl: null,
    hasWorkspaceScopedUrl: false, additionalWorkerNeedsPlan: false,
    selectedStatusMeta: { label: "Ready", bucket: "ready" },
    isSelectedWorkerFailed: false, ownedWorkerCount: 0,
    refreshWorkers: unexpectedAction, launchWorker: unexpectedAction,
    checkWorkerStatus: unexpectedAction, generateWorkerToken: unexpectedAction,
    renameWorker: unexpectedAction, deleteWorker: unexpectedAction, redeployWorker: unexpectedAction,
    refreshRuntime: unexpectedAction, upgradeRuntime: unexpectedAction,
    copyToClipboard: unexpectedAction, getRuntimeServiceLabel: unexpectedAction,
  };
}

async function withShell(
  route: string,
  check: (container: HTMLDivElement) => Promise<void>,
  options: { role?: "admin" | "member"; mcpConnections?: boolean; mobile?: boolean } = {},
) {
  GlobalRegistrator.register({
    url: new URL(route, "https://app.example.test").href,
    width: options.mobile ? 390 : 1440,
  });
  const previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  container.addEventListener("click", (event) => event.preventDefault());
  const role = options.role ?? "admin";
  const orgDirectory = parseOrgListPayload({ orgs: [{
    id: "org-one", name: "Workspace", slug: "workspace", role,
    orgMemberId: "member-one", membershipId: "membership-one", isActive: true,
  }] }).orgs;
  const request = spyOn(requests, "requestJson").mockImplementation(unexpectedAction);
  const fetch = spyOn(globalThis, "fetch").mockImplementation(unexpectedAction);
  const windowFetch = spyOn(window, "fetch").mockImplementation(unexpectedAction);
  const xhr = spyOn(XMLHttpRequest.prototype, "send").mockImplementation(unexpectedAction);
  const pathname = spyOn(navigation, "usePathname").mockImplementation(() => window.location.pathname);
  const denFlow = spyOn(flow, "useDenFlow").mockReturnValue(denFlowFixture());
  const org = spyOn(organization, "useOrgDashboard").mockReturnValue({
    orgSlug: "workspace", orgId: "org-one", orgDirectory, activeOrg: orgDirectory[0],
    orgContext: parseOrgContextPayload({
      organization: { id: "org-one", name: "Workspace", slug: "workspace" },
      currentMember: { id: "member-one", userId: "user-one", role, isOwner: false },
      capabilities: {
        cloud: true, installLinks: true,
        mcpConnections: options.mcpConnections ?? true,
        openworkWeb: true, orgManagedDashboards: true, workflows: true,
      },
    }),
    orgSelectionOpen: false, orgBusy: false, orgError: null, mutationBusy: null,
    reauthDialogOpen: false, orgSettingsCompletion: null,
    clearOrgSettingsCompletion: unexpectedAction, refreshOrgData: unexpectedAction,
    createOrganization: unexpectedAction, updateOrganizationName: unexpectedAction,
    updateOrganizationSettings: unexpectedAction, deleteOrganization: unexpectedAction,
    switchOrganization: unexpectedAction, inviteMember: unexpectedAction,
    startSeatCheckout: unexpectedAction, cancelInvitation: unexpectedAction,
    updateMemberRole: unexpectedAction, removeMember: unexpectedAction,
    transferOwnership: unexpectedAction, createTeam: unexpectedAction,
    updateTeam: unexpectedAction, deleteTeam: unexpectedAction,
    createRole: unexpectedAction, updateRole: unexpectedAction, deleteRole: unexpectedAction,
    runReauthableAction: unexpectedAction,
  });
  const commandPalette = spyOn(palette, "DenCommandPalette").mockImplementation(() => <></>);
  try {
    await act(async () => root.render(<OrgDashboardShell><p>Page content</p></OrgDashboardShell>));
    await check(container);
    expect(request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(windowFetch).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
  } finally {
    try {
      await act(async () => root.unmount());
    } finally {
      for (const spy of [commandPalette, org, denFlow, pathname, xhr, windowFetch, fetch, request]) {
        spy.mockRestore();
      }
      container.remove();
      if (previousActEnvironment) {
        Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
      } else {
        Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      }
      await GlobalRegistrator.unregister();
    }
  }
}

function sidebars(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="den-org-sidebar"]')];
}

function linkNamed(container: HTMLElement, label: string) {
  const links = [...container.querySelectorAll<HTMLAnchorElement>("a")]
    .filter((link) => link.textContent?.trim() === label);
  expect(links).toHaveLength(1);
  const link = links[0];
  if (!link) throw new Error(`Missing ${label} link`);
  return link;
}

function settingsGroup(sidebar: HTMLElement, expanded: boolean) {
  const settings = linkNamed(sidebar, "Settings");
  expect(settings.getAttribute("href")).toBe(generalHref);
  expect(settings.classList.contains("bg-gray-100")).toBe(expanded);
  const group = settings.parentElement;
  if (!group) throw new Error("Missing Settings group");
  expect(settings.nextElementSibling !== null).toBe(expanded);
  return group;
}

function testerChild(sidebar: HTMLElement, selected: boolean) {
  const group = settingsGroup(sidebar, true);
  const tester = linkNamed(group, "Tool Tester");
  expect(sidebar.querySelectorAll(`a[href="${testerHref}"]`)).toHaveLength(1);
  expect(linkNamed(sidebar, "Tool Tester")).toBe(tester);
  expect(tester.getAttribute("href")).toBe(testerHref);
  expect(tester.parentElement).not.toBe(group);
  expect(tester.classList.contains("font-medium")).toBe(selected);
  expect(tester.classList.contains("text-gray-900")).toBe(selected);
  expect(tester.classList.contains("text-gray-500")).toBe(!selected);
  expect(tester.closest('[data-sidebar-section="team"]')).not.toBeNull();
  const manage = sidebar.querySelector('[data-sidebar-section="manage"]');
  expect(manage).not.toBeNull();
  expect(manage?.textContent).not.toContain("Tool Tester");
  expect(manage?.querySelector(`a[href="${testerHref}"]`)).toBeNull();
  expect(tester.tabIndex).toBe(0);
  tester.focus();
  expect(document.activeElement).toBe(tester);
  return tester;
}

async function openMobileMenu(container: HTMLElement) {
  expect(sidebars(container)).toHaveLength(1);
  const menu = container.querySelector<HTMLButtonElement>('button[aria-label="Open menu"]');
  if (!menu) throw new Error("Missing Open menu button");
  await act(async () => menu.click());
  expect(sidebars(container)).toHaveLength(2);
  const mobile = sidebars(container)[1];
  if (!mobile) throw new Error("Missing mobile sidebar");
  return mobile;
}

test.each([
  testerHref,
  `${testerHref}?connectionId=connection-one&toolName=search`,
  `${testerHref}/history`,
])("Tool Tester selects and expands Settings at %s without a Manage duplicate", async (route) => {
  await withShell(route, async (container) => {
    expect(sidebars(container)).toHaveLength(1);
    const sidebar = sidebars(container)[0];
    testerChild(sidebar, true);
    expect(linkNamed(settingsGroup(sidebar, true), "General").classList.contains("font-medium")).toBe(false);
    expect(container.querySelector("header")?.textContent).toContain("Tool Tester");
    expect(container.querySelector("main")?.textContent).toBe("Page content");
    expect(window.location.pathname).toBe(new URL(route, "https://app.example.test").pathname);
    expect(window.location.search).toBe(new URL(route, "https://app.example.test").search);
  });
});

test("General expands Settings with an unselected, focusable Tool Tester child", async () => {
  await withShell(generalHref, async (container) => {
    const sidebar = sidebars(container)[0];
    testerChild(sidebar, false);
    expect(linkNamed(settingsGroup(sidebar, true), "General").classList.contains("font-medium")).toBe(true);
  });
});

test("Connectors keeps Settings collapsed and has no top-level Tool Tester", async () => {
  await withShell("/dashboard/mcp-connections", async (container) => {
    const sidebar = sidebars(container)[0];
    settingsGroup(sidebar, false);
    expect(sidebar.querySelectorAll(`a[href="${testerHref}"]`)).toHaveLength(0);
    expect(sidebar.textContent).not.toContain("Tool Tester");
    const connectors = [...sidebar.querySelectorAll<HTMLAnchorElement>("a")]
      .find((link) => link.getAttribute("href") === "/dashboard/mcp-connections");
    expect(connectors?.classList.contains("bg-gray-100")).toBe(true);
  });
});

test.each([testerHref, generalHref])("mobile Tool Tester at %s stays focusable and closes only the drawer on click", async (route) => {
  await withShell(route, async (container) => {
    const desktop = sidebars(container)[0];
    const mobile = await openMobileMenu(container);
    const tester = testerChild(mobile, route === testerHref);
    testerChild(desktop, route === testerHref);
    tester.focus();
    expect(document.activeElement).toBe(tester);
    await act(async () => tester.click());
    expect(sidebars(container)).toEqual([desktop]);
    expect(mobile.isConnected).toBe(false);
    expect(tester.isConnected).toBe(false);
    expect(window.location.pathname).toBe(route);
    expect(container.querySelector("main")?.textContent).toBe("Page content");
    testerChild(await openMobileMenu(container), route === testerHref);
  }, { mobile: true });
});

test.each([generalHref, testerHref])("members never render Tool Tester in either sidebar at %s", async (route) => {
  await withShell(route, async (container) => {
    await openMobileMenu(container);
    for (const sidebar of sidebars(container)) {
      expect(sidebar.querySelectorAll(`a[href="${testerHref}"]`)).toHaveLength(0);
      expect(sidebar.textContent).not.toContain("Tool Tester");
      expect(sidebar.querySelector('[data-sidebar-section="manage"]')).toBeNull();
    }
  }, { role: "member", mobile: true });
});

test("disabled MCP connections hide Tool Tester but preserve the expanded General settings in both sidebars", async () => {
  await withShell(generalHref, async (container) => {
    await openMobileMenu(container);
    for (const sidebar of sidebars(container)) {
      const group = settingsGroup(sidebar, true);
      expect(linkNamed(group, "General").classList.contains("font-medium")).toBe(true);
      expect(sidebar.querySelectorAll(`a[href="${testerHref}"]`)).toHaveLength(0);
      expect(sidebar.textContent).not.toContain("Tool Tester");
      expect(linkNamed(group, "Diagnostics").getAttribute("href")).toBe("/dashboard/diagnostics");
    }
  }, { mcpConnections: false, mobile: true });
});
