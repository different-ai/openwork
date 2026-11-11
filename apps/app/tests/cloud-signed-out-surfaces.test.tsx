/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Signed out with no stored session: the pages below must ask to sign in
// without reaching Den. Everything they render stays real; only the hooks that
// need the application shell around them are replaced.
let authStatus: "checking" | "signed_out" = "signed_out";
const denAuth = await import("../src/react-app/domains/cloud/den-auth-provider");
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  ...denAuth,
  useDenAuth: () => ({ status: authStatus, isSignedIn: false, user: null, verifiedIdentity: null, error: null, refresh: async () => {} }),
}));
const platform = await import("../src/react-app/kernel/platform");
mock.module("../src/react-app/kernel/platform", () => ({
  ...platform,
  usePlatform: () => ({ openLink: () => {} }),
}));
const desktopConfig = await import("../src/react-app/domains/cloud/desktop-config-provider");
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({
  ...desktopConfig,
  useDesktopConfig: () => ({ config: {}, loading: false, freshConfigStatus: "ready" }),
  useDesktopRestriction: () => false,
}));
const workspace = await import("../src/react-app/shell/workspace-provider");
mock.module("../src/react-app/shell/workspace-provider", () => ({
  ...workspace,
  useWorkspace: () => ({ openworkServerClient: null }),
}));
const savedApps = await import("../src/react-app/domains/apps/use-apps");
mock.module("../src/react-app/domains/apps/use-apps", () => ({
  ...savedApps,
  useSavedApps: () => ({ client: null, orgId: null, query: { isPending: false, isFetched: false } }),
}));
const orgConnections = await import("../src/react-app/domains/connections/use-org-mcp-connections");
mock.module("../src/react-app/domains/connections/use-org-mcp-connections", () => ({
  ...orgConnections,
  useOrgMcpConnections: () => ({ connections: [] }),
}));
mock.module("../src/react-app/domains/dashboard/artifacts-page", () => ({
  ArtifactsPage: () => <div data-artifacts-list />,
}));

const { cloudSurfaceAvailable } = await import("../src/react-app/domains/cloud/cloud-surface-availability");
const { DashboardPage } = await import("../src/react-app/domains/dashboard/dashboard-page");
const { AutomationsPage } = await import("../src/react-app/domains/automations/automations-page");

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement;
let requests: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  authStatus = "signed_out";
  requests = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response("{}", { status: 401 });
  }, { preconnect: realFetch.preconnect });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  mock.restore();
  if (ownsDom) await GlobalRegistrator.unregister();
});

async function render(page: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(<QueryClientProvider client={client}><MemoryRouter>{page}</MemoryRouter></QueryClientProvider>);
  });
}

function signInButton() {
  return [...host.querySelectorAll("button")].find((button) => button.textContent === "Sign in to OpenWork Cloud");
}

test("Artifacts and Automations exist signed out on every runtime, and follow the deployment once signed in", () => {
  // Signed out: there whether or not a deployment has turned the page on.
  expect(cloudSurfaceAvailable({ deploymentEnabled: false, authChecking: false, signedIn: false })).toBe(true);
  expect(cloudSurfaceAvailable({ deploymentEnabled: true, authChecking: false, signedIn: false })).toBe(true);
  // Signed in: Den's flag for the page decides.
  expect(cloudSurfaceAvailable({ deploymentEnabled: true, authChecking: false, signedIn: true })).toBe(true);
  expect(cloudSurfaceAvailable({ deploymentEnabled: false, authChecking: false, signedIn: true })).toBe(false);
  // Still checking a stored session: not shown for a deployment that may have it off.
  expect(cloudSurfaceAvailable({ deploymentEnabled: false, authChecking: true, signedIn: false })).toBe(false);
  expect(cloudSurfaceAvailable({ deploymentEnabled: true, authChecking: true, signedIn: false })).toBe(true);
});

test("signed out, Artifacts is one empty state that asks to sign in", async () => {
  let signIns = 0;
  await render(<DashboardPage onCreateApp={async () => {}} onSignIn={() => { signIns += 1; }} />);

  const prompt = host.querySelector('[data-testid="dashboard-sign-in"]');
  expect(prompt?.textContent).toContain("Sign in to see the artifacts you and your team build");
  expect(host.querySelector("[data-artifacts-list]")).toBeNull();

  await act(async () => signInButton()?.click());
  expect(signIns).toBe(1);
  expect(requests).toEqual([]);
});

test("signed out, Automations is one empty state that asks to sign in", async () => {
  let signIns = 0;
  await render(<AutomationsPage onSignIn={() => { signIns += 1; }} />);

  const prompt = host.querySelector('[data-testid="automations-sign-in"]');
  expect(prompt?.textContent).toContain("Sign in to schedule tasks that run on your desktop or in the cloud");
  // Nothing that needs an account is offered beside the prompt.
  expect(host.textContent).not.toContain("New Automation");
  expect(host.textContent).not.toContain("No Automations yet");

  await act(async () => signInButton()?.click());
  expect(signIns).toBe(1);
  expect(requests).toEqual([]);
});

test("while a stored session is still being checked, neither page asks to sign in", async () => {
  authStatus = "checking";
  await render(<><DashboardPage onCreateApp={async () => {}} onSignIn={() => {}} /><AutomationsPage onSignIn={() => {}} /></>);

  expect(signInButton()).toBeUndefined();
  expect(host.querySelector('[role="status"]')).not.toBeNull();
});
