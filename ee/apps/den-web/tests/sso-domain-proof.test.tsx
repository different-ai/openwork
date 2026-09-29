import { afterAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { DenOrgSsoConnection } from "../app/(den)/_lib/den-org";

GlobalRegistrator.register({ url: "https://app.example.test/dashboard/sso" });
const priorActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => {
  if (priorActEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  await GlobalRegistrator.unregister();
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const runtime = await import("../app/(den)/_lib/runtime-config");
const { parseOrgContextPayload, parseOrgSsoPayload } = await import("../app/(den)/_lib/den-org");
const organization = await import("../app/(den)/dashboard/_providers/org-dashboard-provider");
const { SsoScreen } = await import("../app/(den)/dashboard/_components/sso-screen");

const orgId = "org-fixture";
const challenge = "synthetic-dns-challenge";
const requestTokenPath = "/v1/sso/request-domain-verification";
const verifyDomainPath = "/v1/sso/verify-domain";

function connectionFixture(): DenOrgSsoConnection {
  return {
    id: "sso-fixture", providerId: "provider-fixture", kind: "oidc",
    issuer: "https://idp.example.test", domain: "example.test",
    status: "enabled", testStatus: "succeeded", testExpiresAt: null,
    signInPath: "/sso/fixture", signInUrl: "https://app.example.test/sso/fixture",
    redirectUrl: "https://app.example.test/api/auth/sso/callback/provider-fixture",
    acsUrl: null, metadataUrl: null,
    domainVerified: true, emailDomainVerified: false,
    domainVerificationHost: "_sso-challenge-provider-fixture",
    domainVerificationDnsName: "_sso-challenge-provider-fixture.example.test",
    oidc: {
      clientId: "fixture-client", scopes: ["openid", "email", "profile"], skipDiscovery: false,
      authorizationEndpoint: null, tokenEndpoint: null, jwksEndpoint: null,
      userInfoEndpoint: null, tokenEndpointAuthentication: null,
    },
    saml: null, lastTestedAt: "2026-01-15T05:00:00.000Z", lastError: null,
    createdAt: "2026-01-15T05:00:00.000Z", updatedAt: "2026-01-15T05:00:00.000Z",
  };
}

type Call = { path: string; method: string; body: unknown; scope: string | null };
type View = {
  container: HTMLDivElement;
  calls: Call[];
  actions: string[];
  button: (label: string) => HTMLButtonElement;
  click: (label: string) => Promise<void>;
  ownership: () => string | null;
  status: () => string | null;
  writes: () => Call[];
};
type Options = {
  role?: string;
  connection?: Record<string, unknown>;
  respond?: (call: Call) => Response | Promise<Response> | undefined;
};

async function withScreen(check: (view: View) => Promise<void>, options: Options = {}) {
  let connection = { ...connectionFixture(), ...options.connection };
  const calls: Call[] = [];
  const actions: string[] = [];
  const role = options.role ?? "owner";
  const noop = async () => {};
  const org = spyOn(organization, "useOrgDashboard").mockReturnValue({
    orgSlug: "fixture", orgId, orgDirectory: [], activeOrg: null,
    orgContext: parseOrgContextPayload({
      organization: { id: orgId, name: "Example Workspace", slug: "fixture" },
      currentMember: { id: "member-fixture", userId: "user-fixture", role, isOwner: role === "owner" },
    }),
    orgSelectionOpen: false, orgBusy: false, orgError: null, mutationBusy: null,
    reauthDialogOpen: false, orgSettingsCompletion: null,
    clearOrgSettingsCompletion: noop, refreshOrgData: noop, createOrganization: noop,
    updateOrganizationName: noop, updateOrganizationSettings: noop, deleteOrganization: noop,
    switchOrganization: noop, inviteMember: noop, startSeatCheckout: noop, cancelInvitation: noop,
    updateMemberRole: noop, removeMember: noop, transferOwnership: noop,
    createTeam: noop, updateTeam: noop, deleteTeam: noop, createRole: noop, updateRole: noop, deleteRole: noop,
    runReauthableAction: async (label, action) => { actions.push(label); await action(); },
  });
  const config = spyOn(runtime, "getRuntimeConfig").mockResolvedValue(runtime.EMPTY_RUNTIME_CONFIG);
  const network = spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const call = {
      path: url.pathname.replace(/^\/api\/browser/, ""),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      scope: new Headers(init.headers).get("x-openwork-legacy-org-id"),
    };
    calls.push(call);
    const reply = await options.respond?.(call);
    if (reply) return reply;
    if (call.path === "/v1/sso" && call.method === "GET") return Response.json({ connection });
    if (call.path === requestTokenPath && call.method === "POST") return Response.json({ domainVerificationToken: challenge });
    if (call.path === verifyDomainPath && call.method === "POST") {
      connection = { ...connection, domainVerified: true, emailDomainVerified: true };
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${call.method} ${call.path}`);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  try {
    await act(async () => { root.render(<SsoScreen />); });
    await check({
      container, calls, actions, button,
      click: async (label) => { await act(async () => { button(label).click(); }); },
      ownership: () => container.querySelector('[data-testid="sso-domain-ownership"]')?.textContent ?? null,
      status: () => container.querySelector('[data-testid="sso-connection-status"]')?.textContent ?? null,
      writes: () => calls.filter((call) => call.method !== "GET"),
    });
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    network.mockRestore();
    config.mockRestore();
    org.mockRestore();
  }
}

function expectWrite(call: Call | undefined, path: string) {
  expect(call).toEqual({ path, method: "POST", body: {}, scope: orgId });
}

test("enabled legacy SSO keeps working while domain ownership needs verification", async () => {
  await withScreen(async ({ container, ownership, status, button, calls }) => {
    expect(status()).toBe("Enabled");
    expect(ownership()).toBe("Domain ownership: Verification needed");
    expect(button("Disable SSO").disabled).toBe(false);
    expect(button("Request token").disabled).toBe(false);
    expect(button("Verify domain").disabled).toBe(true);
    expect(container.querySelector('[data-testid="sso-domain-verification"]')?.getAttribute("open")).not.toBeNull();
    expect(container.querySelector('[data-testid="sso-test-dialog"]')).toBeNull();
    expect(container.textContent).not.toContain("SSO remains inactive");
    expect(container.textContent).not.toContain("Domain verified");
    expect(container.textContent).not.toContain("DNS TXT record was a one-time proof");
    expect(calls).toEqual([{ path: "/v1/sso", method: "GET", body: null, scope: orgId }]);
  });
});

for (const value of [undefined, null, false, "true", 1, { verified: true }]) {
  test(`mounted ownership status fails closed for emailDomainVerified=${JSON.stringify(value)}`, async () => {
    await withScreen(async ({ ownership, status, button }) => {
      expect(ownership()).toBe("Domain ownership: Verification needed");
      expect(status()).toBe("Enabled");
      expect(button("Request token").disabled).toBe(false);
    }, { connection: { emailDomainVerified: value } });
  });
}

for (const domainVerified of [false, true]) {
  test(`only genuine email-domain proof renders Verified, legacy flag=${domainVerified}`, async () => {
    await withScreen(async ({ container, ownership, status }) => {
      expect(ownership()).toBe("Domain ownership: Verified");
      expect(status()).toBe("Enabled");
      expect(container.querySelector('[data-testid="sso-domain-verification"]')).toBeNull();
      expect(container.textContent).not.toContain("Request token");
      expect(container.textContent).not.toContain("Verify domain");
    }, { connection: { emailDomainVerified: true, domainVerified } });
  });
}

test("the proof contract is connection.emailDomainVerified, not a top-level or provider-config claim", () => {
  const connection = { ...connectionFixture(), emailDomainVerified: undefined, oidc: { ...connectionFixture().oidc, emailDomainVerified: true } };
  expect(parseOrgSsoPayload({ connection, emailDomainVerified: true }).connection?.emailDomainVerified).toBe(false);
  expect(parseOrgSsoPayload({ connection }).connection?.domainVerified).toBe(true);
});

test("requesting a DNS TXT challenge never disables, edits, or retests enabled SSO", async () => {
  await withScreen(async ({ container, click, button, ownership, status, writes, actions }) => {
    await click("Request token");
    expect(container.textContent).toContain(challenge);
    expect(container.textContent).toContain("_sso-challenge-provider-fixture.example.test");
    expect(ownership()).toBe("Domain ownership: Verification needed");
    expect(status()).toBe("Enabled");
    expect(button("Verify domain").disabled).toBe(false);
    expect(button("Disable SSO").disabled).toBe(false);
    expect(container.querySelector('[data-testid="sso-test-dialog"]')).toBeNull();
    expect(writes()).toHaveLength(1);
    expectWrite(writes()[0], requestTokenPath);
    expect(actions).toEqual(["load-sso-settings", "request-sso-domain-token"]);
  });
});

test("a confirmed DNS check refreshes proof while preserving enabled SSO and the successful IdP test", async () => {
  await withScreen(async ({ container, click, ownership, status, writes, calls, actions }) => {
    await click("Request token");
    await click("Verify domain");
    expect(ownership()).toBe("Domain ownership: Verified");
    expect(status()).toBe("Enabled");
    expect(container.textContent).toContain("Test: Successful");
    expect(container.textContent).not.toContain(challenge);
    expect(container.querySelector('[data-testid="sso-test-dialog"]')).toBeNull();
    expect(writes()).toHaveLength(2);
    expectWrite(writes()[0], requestTokenPath);
    expectWrite(writes()[1], verifyDomainPath);
    expect(calls.filter((call) => call.path === "/v1/sso")).toHaveLength(2);
    expect(actions).toEqual(["load-sso-settings", "request-sso-domain-token", "verify-sso-domain"]);
  });
});

test("confirming DNS for a new connection does not enable SSO or skip its IdP test", async () => {
  await withScreen(async ({ container, click, ownership, status, button, writes }) => {
    expect(status()).toBe("Saved · disabled");
    expect(button("Enable Config").disabled).toBe(true);
    await click("Request token");
    await click("Verify domain");
    expect(ownership()).toBe("Domain ownership: Verified");
    expect(status()).toBe("Saved · disabled");
    expect(button("Enable Config").disabled).toBe(false);
    expect(container.textContent).toContain("Test: Not tested");
    expect(container.querySelector('[data-testid="sso-test-dialog"]')).toBeNull();
    expect(writes()).toHaveLength(2);
    expectWrite(writes()[0], requestTokenPath);
    expectWrite(writes()[1], verifyDomainPath);
  }, { connection: { status: "disabled", testStatus: "untested", domainVerified: false } });
});

test("an accepted DNS check without refreshed proof cannot optimistically claim Verified", async () => {
  await withScreen(async ({ container, click, ownership, status, button }) => {
    await click("Request token");
    await click("Verify domain");
    expect(ownership()).toBe("Domain ownership: Verification needed");
    expect(status()).toBe("Enabled");
    expect(container.textContent).toContain(challenge);
    expect(button("Verify domain").disabled).toBe(false);
  }, { respond: (call) => call.path === verifyDomainPath ? new Response(null, { status: 204 }) : undefined });
});

test("a DNS verification failure keeps the token and enabled configuration available for retry", async () => {
  await withScreen(async ({ container, click, ownership, status, button, writes }) => {
    await click("Request token");
    await click("Verify domain");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("TXT record not found. Check the record and try again.");
    expect(ownership()).toBe("Domain ownership: Verification needed");
    expect(status()).toBe("Enabled");
    expect(container.textContent).toContain(challenge);
    expect(button("Verify domain").disabled).toBe(false);
    expect(writes()).toHaveLength(2);
    expectWrite(writes()[1], verifyDomainPath);
  }, { respond: (call) => call.path === verifyDomainPath ? Response.json({ error: "invalid_request", details: [{ message: "TXT record not found. Check the record and try again." }] }, { status: 400 }) : undefined });
});

test("a failed proof refresh leaves the last enabled state and never claims ownership", async () => {
  let verified = false;
  await withScreen(async ({ container, click, ownership, status, button }) => {
    await click("Request token");
    await click("Verify domain");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not refresh SSO. Try again.");
    expect(ownership()).toBe("Domain ownership: Verification needed");
    expect(status()).toBe("Enabled");
    expect(container.textContent).toContain(challenge);
    expect(button("Verify domain").disabled).toBe(false);
  }, {
    respond: (call) => {
      if (call.path === verifyDomainPath) {
        verified = true;
        return new Response(null, { status: 204 });
      }
      if (call.path === "/v1/sso" && verified) return Response.json({ message: "Could not refresh SSO. Try again." }, { status: 503 });
      return undefined;
    },
  });
});

test("a failed token request gives a next action without claiming proof or changing SSO", async () => {
  await withScreen(async ({ container, click, ownership, status, button, writes }) => {
    await click("Request token");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not request a token. Try again.");
    expect(ownership()).toBe("Domain ownership: Verification needed");
    expect(status()).toBe("Enabled");
    expect(button("Verify domain").disabled).toBe(true);
    expect(writes()).toHaveLength(1);
  }, { respond: (call) => call.path === requestTokenPath ? Response.json({ message: "Could not request a token. Try again." }, { status: 503 }) : undefined });
});

test("an incomplete challenge response keeps verification blocked and offers another request", async () => {
  await withScreen(async ({ container, click, ownership, status, button }) => {
    await click("Request token");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Request a new token.");
    expect(ownership()).toBe("Domain ownership: Verification needed");
    expect(status()).toBe("Enabled");
    expect(button("Verify domain").disabled).toBe(true);
    expect(button("Request token").disabled).toBe(false);
  }, { respond: (call) => call.path === requestTokenPath ? Response.json({}) : undefined });
});

test("ordinary admins see ownership and locked DNS controls, not an error or a hidden capability", async () => {
  await withScreen(async ({ container, ownership, status, button, click, writes }) => {
    expect(ownership()).toBe("Domain ownership: Verification needed");
    expect(status()).toBe("Enabled");
    expect(container.querySelector("#sso-read-only")?.textContent).toContain("owners and super-admins can change SSO settings and verify domains");
    expect(container.querySelector("#sso-read-only svg")).not.toBeNull();
    expect(button("Request token").disabled).toBe(true);
    expect(button("Verify domain").disabled).toBe(true);
    expect(button("Request token").getAttribute("aria-describedby")).toBe("sso-read-only");
    await click("Request token");
    await click("Verify domain");
    expect(writes()).toEqual([]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  }, { role: "admin" });
});

test("members see the SSO access restriction and cannot request or verify DNS proof", async () => {
  await withScreen(async ({ container, calls, ownership }) => {
    expect(container.textContent).toContain("Only workspace admins can view SSO.");
    expect(container.querySelector('[data-testid="sso-domain-verification"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(ownership()).toBeNull();
    expect(calls).toEqual([]);
  }, { role: "member" });
});

test("super-admins can verify ownership without disabling the existing connection", async () => {
  await withScreen(async ({ click, status, ownership, writes }) => {
    await click("Request token");
    await click("Verify domain");
    expect(status()).toBe("Enabled");
    expect(ownership()).toBe("Domain ownership: Verified");
    expect(writes()).toHaveLength(2);
    expectWrite(writes()[0], requestTokenPath);
    expectWrite(writes()[1], verifyDomainPath);
  }, { role: "super-admin" });
});
