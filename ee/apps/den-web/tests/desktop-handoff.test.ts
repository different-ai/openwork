import { expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as navigation from "next/navigation";
import * as requests from "../app/(den)/_lib/den-flow";
import * as runtime from "../app/(den)/_lib/runtime-config";
import { DenFlowProvider, useDenFlow } from "../app/(den)/_providers/den-flow-provider";
import {
  getDesktopGrant,
  getDesktopHandoffGrant,
  getDesktopHandoffOpenworkUrl,
} from "../app/(den)/_lib/desktop-handoff";
import { SETUP_CONTINUATION_KEY, parseSetupContinuation, type SetupContinuation } from "../app/(den)/_lib/setup-continuation";

test("preserves the complete OpenWork desktop handoff URL", () => {
  const openworkUrl = "openwork://den-auth?grant=one-time-code&denBaseUrl=https%3A%2F%2Fapi.example.test";
  const payload = { grant: "one-time-code", openworkUrl };

  expect(getDesktopHandoffOpenworkUrl(payload)).toBe(openworkUrl);
  expect(getDesktopHandoffGrant(payload, openworkUrl)).toBe("one-time-code");
});

test("extracts a one-time grant from an OpenWork desktop handoff", () => {
  expect(
    getDesktopGrant(
      "openwork://den-auth?grant=one-time-code&baseUrl=https%3A%2F%2Fapi.example.test"
    )
  ).toBe("one-time-code");
});

test("rejects missing and malformed desktop handoffs", () => {
  expect(
    getDesktopGrant(
      "openwork://den-auth?baseUrl=https%3A%2F%2Fapi.example.test"
    )
  ).toBeNull();
  expect(getDesktopGrant("not a url")).toBeNull();
  expect(getDesktopGrant(null)).toBeNull();
});

test("restores only fresh tab-scoped setup with a user and a known route", () => {
  const pending = { userId: "user-1", desktopScheme: "openwork", setup: { organizationId: "org-1", route: "/dashboard/onboarding/tools" }, at: Date.now() };
  expect(parseSetupContinuation(JSON.stringify(pending))).toEqual(pending);
  expect(parseSetupContinuation(JSON.stringify({ ...pending, setup: null, userId: null }))).toMatchObject({ userId: null, setup: null });
  for (const invalid of [
    { ...pending, userId: null },
    { ...pending, at: Date.now() - 25 * 60 * 60 * 1000 },
    { ...pending, at: Date.now() + 60_000 },
    { ...pending, setup: { organizationId: "org-1", route: "https://outside.test" } },
    { ...pending, desktopScheme: "openwork://" },
    { ...pending, setup: { route: "/dashboard/onboarding" } },
  ]) expect(parseSetupContinuation(JSON.stringify(invalid))).toBeNull();
  expect(parseSetupContinuation("not json")).toBeNull();
});

const account = { id: "user-1", email: "member@openwork.test", name: "Member" };
const directory = { orgs: [{ id: "org-1", name: "Team", slug: "team", role: "owner", orgMemberId: "member-1", membershipId: "membership-1" }] };
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred result not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withFlow(options: {
  config?: Promise<runtime.DenWebRuntimeConfig>;
  stored?: SetupContinuation;
  desktop?: boolean;
  reply?: (path: string) => Promise<{ status?: number; payload: unknown }>;
}, check: (fixture: { state: () => ReturnType<typeof useDenFlow>; paths: string[]; opened: string[]; submit: () => void }) => Promise<void>) {
  GlobalRegistrator.register({ url: `https://app.example.test/${options.desktop === false ? "" : "?desktopAuth=1"}` });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  if (options.stored) sessionStorage.setItem(SETUP_CONTINUATION_KEY, JSON.stringify(options.stored));
  const paths: string[] = [];
  const opened: string[] = [];
  spyOn(navigation, "usePathname").mockReturnValue("/");
  spyOn(navigation, "useRouter").mockReturnValue({ push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch: async () => {} });
  spyOn(runtime, "getRuntimeConfig").mockImplementation(() => options.config ?? Promise.resolve({ ...runtime.EMPTY_RUNTIME_CONFIG, orgMode: "multi_org" }));
  spyOn(window.location, "assign").mockImplementation((url) => { opened.push(String(url)); });
  spyOn(requests, "requestJson").mockImplementation(async (path) => {
    paths.push(path);
    const reply = options.reply ? await options.reply(path) : { payload: path === "/v1/me" ? { user: account } : path === "/v1/me/orgs" ? directory : {} };
    return { response: Response.json(reply.payload, { status: reply.status ?? 200 }), payload: reply.payload };
  });
  let current: ReturnType<typeof useDenFlow> | null = null;
  function Capture() {
    const flow = useDenFlow();
    current = flow;
    return createElement("form", { onSubmit: (event) => { void flow.submitAuth(event); } });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(DenFlowProvider, null, createElement(Capture))); });
    await check({
      state: () => { if (!current) throw new Error("Flow not mounted"); return current; }, paths, opened,
      submit: () => { container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); },
    });
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    await GlobalRegistrator.unregister();
  }
}

test.each(["multi_org", "single_org"] satisfies runtime.DenWebRuntimeConfig["orgMode"][])("%s waits for runtime and the authenticated session before classifying an empty directory", async (orgMode) => {
  const config = deferred<runtime.DenWebRuntimeConfig>();
  const me = deferred<{ user: typeof account }>();
  await withFlow({ config: config.promise, reply: async (path) => ({ payload: path === "/v1/me" ? await me.promise : path === "/v1/me/orgs" ? { orgs: [] } : {} }) }, async ({ state, paths }) => {
    expect(await state().resolveUserLandingRoute()).toBeNull();
    expect(paths).not.toContain("/v1/me/orgs");
    await act(async () => config.resolve({ ...runtime.EMPTY_RUNTIME_CONFIG, orgMode }));
    expect(state().runtimeConfigLoaded).toBe(true);
    expect(state().sessionHydrated).toBe(false);
    expect(await state().resolveUserLandingRoute()).toBeNull();
    expect(paths).not.toContain("/v1/me/orgs");
    await act(async () => me.resolve({ user: account }));
    expect(state().sessionHydrated).toBe(true);
    expect(state().setupPending).toBe(orgMode === "multi_org");
    expect(paths).not.toContain("/api/auth/desktop-handoff");
  });
});

test("sign-out invalidates an in-flight session response and clears the tab continuation", async () => {
  const me = deferred<{ user: typeof account }>();
  await withFlow({ reply: async (path) => ({ payload: path === "/v1/me" ? await me.promise : {} }) }, async ({ state, paths }) => {
    await act(async () => state().signOut());
    await act(async () => me.resolve({ user: account }));
    expect(state().user).toBeNull();
    expect(state().sessionHydrated).toBe(true);
    expect(sessionStorage.getItem(SETUP_CONTINUATION_KEY)).toBeNull();
    expect(paths).not.toContain("/api/auth/desktop-handoff");
  });
});

test("a different authenticated user cannot inherit an earlier user's setup or desktop return", async () => {
  await withFlow({ stored: { userId: "old-user", desktopScheme: "openwork", setup: { organizationId: "old-org", route: "/dashboard/onboarding/tools" }, at: Date.now() } }, async ({ state, paths }) => {
    expect(state().user?.id).toBe(account.id);
    expect(state().setupPending).toBe(false);
    expect(state().desktopAuthRequested).toBe(false);
    expect(sessionStorage.getItem(SETUP_CONTINUATION_KEY)).toBeNull();
    expect(paths).not.toContain("/api/auth/desktop-handoff");
  });
});

test("an organization lookup failure neither starts setup nor issues a handoff", async () => {
  await withFlow({ reply: async (path) => path === "/v1/me/orgs"
    ? { status: 503, payload: { message: "Directory unavailable" } }
    : { payload: path === "/v1/me" ? { user: account } : {} } }, async ({ state, paths }) => {
    expect(state().authError).toBeTruthy();
    expect(state().setupPending).toBe(false);
    expect(paths).not.toContain("/api/auth/desktop-handoff");
  });
});

test.each([runtime.EMPTY_RUNTIME_CONFIG, { ...runtime.EMPTY_RUNTIME_CONFIG }])("fallback or single-org config never discards unfinished setup", async (config) => {
  const setup = { organizationId: "org-1", route: "/dashboard/onboarding/people" };
  await withFlow({ config: Promise.resolve(config), stored: { userId: account.id, desktopScheme: "openwork", setup, at: Date.now() } }, async ({ state, paths }) => {
    expect(state().setupPending).toBe(true);
    expect(await state().resolveUserLandingRoute()).toBe(setup.route);
    expect(parseSetupContinuation(sessionStorage.getItem(SETUP_CONTINUATION_KEY))?.setup).toEqual(setup);
    expect(paths).not.toContain("/api/auth/desktop-handoff");
  });
});

test("failed runtime config cannot classify a new account or hand off a returning account", async () => {
  await withFlow({ config: Promise.resolve(runtime.EMPTY_RUNTIME_CONFIG) }, async ({ state, paths }) => {
    expect(state().authError).toContain("workspace configuration");
    let route: string | null = null;
    await act(async () => { route = await state().resolveUserLandingRoute(); });
    expect(route).toBeNull();
    expect(paths).not.toContain("/v1/me/orgs");
    expect(paths).not.toContain("/api/auth/desktop-handoff");
  });
});

test("sign-out discards a late handoff result without opening the app", async () => {
  const handoff = deferred<{ payload: unknown }>();
  await withFlow({ reply: async (path) => path === "/api/auth/desktop-handoff" ? handoff.promise
    : { payload: path === "/v1/me" ? { user: account } : path === "/v1/me/orgs" ? directory : {} } }, async ({ state, paths, opened }) => {
    expect(paths).toContain("/api/auth/desktop-handoff");
    await act(async () => state().signOut());
    await act(async () => handoff.resolve({ payload: { grant: "stale-test-grant", openworkUrl: "openwork://den-auth?grant=stale-test-grant" } }));
    expect(opened).toEqual([]);
    expect(state().desktopRedirectUrl).toBeNull();
    expect(state().user).toBeNull();
  });
});

test("changing the auth token requires the new session to hydrate before landing decisions", async () => {
  const signedIn = deferred<{ user: typeof account }>();
  let signingIn = false;
  await withFlow({ desktop: false, reply: async (path) => {
    if (path === "/api/auth/sign-in/email") { signingIn = true; return { payload: { token: "replacement-test-token", user: account } }; }
    return { payload: path === "/v1/me" ? signingIn ? await signedIn.promise : { user: account } : {} };
  } }, async ({ state, paths, submit }) => {
    expect(state().sessionHydrated).toBe(true);
    await act(async () => { state().setAuthMode("sign-in"); state().setEmail(account.email); state().setPassword("test-password"); });
    await act(async () => submit());
    expect(state().sessionHydrated).toBe(false);
    expect(await state().resolveUserLandingRoute()).toBeNull();
    expect(paths).not.toContain("/v1/me/orgs");
    await act(async () => signedIn.resolve({ user: account }));
    expect(state().sessionHydrated).toBe(true);
  });
});

test("a returning user's failed handoff can retry without signing in again", async () => {
  let attempts = 0;
  await withFlow({ reply: async (path) => {
    if (path === "/api/auth/desktop-handoff") {
      attempts += 1;
      return attempts === 1 ? { status: 503, payload: { message: "Try again" } } : { payload: { grant: "test-grant", openworkUrl: "openwork://den-auth?grant=test-grant" } };
    }
    return { payload: path === "/v1/me" ? { user: account } : path === "/v1/me/orgs" ? directory : {} };
  } }, async ({ state, opened }) => {
    expect(state().authError).toBeTruthy();
    expect(attempts).toBe(1);
    await act(async () => state().retryDesktopAuthHandoff());
    expect(state().authError).toBeNull();
    expect(attempts).toBe(2);
    expect(opened).toEqual(["openwork://den-auth?grant=test-grant"]);
    expect(sessionStorage.getItem(SETUP_CONTINUATION_KEY)).toBeNull();
  });
});
