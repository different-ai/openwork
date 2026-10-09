import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getSocialCallbackUrl } from "./den-flow";
import {
  getSafeMemberReturnTo,
  resolveMemberAuthGuardDecision,
  resolveMemberReturnTo,
  type MemberRoute,
  type SetupBootstrapStatus,
} from "./member-auth-routing";

type GuardInput = Parameters<typeof resolveMemberAuthGuardDecision>[0];

const signedOutInstall: GuardInput = {
  route: "/install",
  hasInstallToken: false,
  setupStatus: "complete",
  authCheckStatus: "ready",
  signedIn: false,
  singleOrgSsoConfigured: true,
  singleOrgSlug: "default",
};
const memberRoutes: MemberRoute[] = ["/install", "/setup"];
const bootstrapStates: SetupBootstrapStatus[] = ["loading", "available", "unavailable"];
const unsafeReturnTargets = [
  undefined, null, "", "https://attacker.invalid/install", "//attacker.invalid/install",
  "/\\attacker.invalid/install", "/install?token=secret", "/setup#complete",
  "/dashboard", "/install/", "/%69nstall", "javascript:alert(1)",
];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

function browserLocation(path: string) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: new URL(path, "https://den.example") },
  });
}

for (const route of memberRoutes) {
  test(`${route} redirects signed-out members to configured SSO`, () => {
    assert.equal(resolveMemberAuthGuardDecision({ ...signedOutInstall, route }), "sso");
  });

  test(`${route} uses generic sign-in when SSO is not configured or has no slug`, () => {
    assert.equal(resolveMemberAuthGuardDecision({ ...signedOutInstall, route, singleOrgSsoConfigured: false }), "sign-in");
    assert.equal(resolveMemberAuthGuardDecision({ ...signedOutInstall, route, singleOrgSlug: " " }), "sign-in");
  });

  test(`${route} renders for a signed-in member only after a successful auth check`, () => {
    assert.equal(resolveMemberAuthGuardDecision({ ...signedOutInstall, route, signedIn: true }), "render");
    for (const signedIn of [false, true]) {
      assert.equal(resolveMemberAuthGuardDecision({ ...signedOutInstall, route, signedIn, authCheckStatus: "checking" }), "wait");
      assert.equal(resolveMemberAuthGuardDecision({ ...signedOutInstall, route, signedIn, authCheckStatus: "error" }), "error");
    }
  });

  test(`${route} is a validated return target unless a desktop or web handoff takes priority`, () => {
    assert.equal(getSafeMemberReturnTo(route), route);
    assert.equal(resolveMemberReturnTo(route, false), route);
    assert.equal(resolveMemberReturnTo(route, true), null);
  });
}

test("first-administrator bootstrap stays public without waiting for member auth", () => {
  for (const setupStatus of bootstrapStates) {
    for (const authCheckStatus of ["checking", "ready", "error"] satisfies GuardInput["authCheckStatus"][]) {
      assert.equal(resolveMemberAuthGuardDecision({ ...signedOutInstall, route: "/setup", setupStatus, authCheckStatus }), "render");
    }
  }
});

test("token installs stay public but a token does not bypass completed setup authentication", () => {
  for (const authCheckStatus of ["checking", "ready", "error"] satisfies GuardInput["authCheckStatus"][]) {
    assert.equal(resolveMemberAuthGuardDecision({ ...signedOutInstall, hasInstallToken: true, authCheckStatus }), "render");
  }
  assert.equal(resolveMemberAuthGuardDecision({ ...signedOutInstall, route: "/setup", hasInstallToken: true }), "sso");
});

test("return targets reject external URLs, unknown pages, fragments and token-bearing queries", () => {
  for (const target of unsafeReturnTargets) {
    assert.equal(getSafeMemberReturnTo(target), null);
    assert.equal(resolveMemberReturnTo(target, false), null);
  }
});

for (const route of memberRoutes) {
  test(`social callback carries the validated ${route} return target`, () => {
    browserLocation(`/?returnTo=${encodeURIComponent(route)}`);
    const callback = new URL(getSocialCallbackUrl());
    assert.equal(callback.origin, "https://den.example");
    assert.equal(callback.pathname, "/");
    assert.equal(callback.searchParams.get("returnTo"), route);
  });
}

test("explicit member return targets override query values and null clears them", () => {
  browserLocation("/?returnTo=%2Finstall");
  assert.equal(new URL(getSocialCallbackUrl("", "/setup")).searchParams.get("returnTo"), "/setup");
  assert.equal(new URL(getSocialCallbackUrl("", null)).searchParams.has("returnTo"), false);
  assert.equal(new URL(getSocialCallbackUrl("", "https://attacker.invalid/setup")).searchParams.has("returnTo"), false);
});

test("social callbacks discard unsafe return targets from the query and explicit arguments", () => {
  for (const target of unsafeReturnTargets) {
    browserLocation(`/?${new URLSearchParams({ returnTo: target ?? "" })}`);
    assert.equal(new URL(getSocialCallbackUrl()).searchParams.has("returnTo"), false);
    assert.equal(new URL(getSocialCallbackUrl("", target)).searchParams.has("returnTo"), false);
  }
});

test("social callbacks preserve existing handoff, invitation and intent parameters on the configured origin", () => {
  const preserved = new URLSearchParams({
    mode: "sign-in", desktopAuth: "1", desktopScheme: "openwork", webAuth: "1",
    webAuthReturn: "https://cloud.example/callback", invite: "invitation", intent: "models",
  });
  browserLocation(`/?${preserved}&returnTo=%2Fsetup&token=must-not-copy`);
  const callback = new URL(getSocialCallbackUrl("https://callback.example"));
  assert.equal(callback.origin, "https://callback.example");
  assert.equal(callback.pathname, "/");
  for (const [key, value] of preserved) assert.equal(callback.searchParams.get(key), value);
  assert.equal(callback.searchParams.get("returnTo"), "/setup");
  assert.equal(callback.searchParams.has("token"), false);
});

test("MCP OAuth resumes its exact signed query without adding the explicit member target", () => {
  const search = "?response_type=code&client_id=agent&scope=mcp%3Aread+offline_access&state=state%2Bvalue&exp=2000000000&sig=signed%2Fquery";
  browserLocation(`/${search}`);
  assert.equal(getSocialCallbackUrl("https://callback.example", "/install"), `https://callback.example/${search}`);
});

for (const path of ["/connect/mcp", "/device", "/claim"]) {
  test(`${path} keeps its in-place sign-in callback ahead of a member return target`, () => {
    const search = "?code=resume-code&returnTo=%2Finstall";
    browserLocation(`${path}/${search}`);
    assert.equal(getSocialCallbackUrl("https://callback.example", "/setup"), `https://callback.example${path}${search}`);
  });
}
