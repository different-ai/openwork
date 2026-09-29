import { expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as navigation from "next/navigation";
import * as runtime from "../app/(den)/_lib/runtime-config";
import SsoTestStartPage from "../app/sso/test/page";
import OrganizationSsoSignInPage from "../app/sso/[orgSlug]/page";

const idpUrl = "https://idp.example.test/authorize?state=fixture";

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred value not initialized"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withSsoPage(strict: boolean, check: (fixture: {
  calls: { input: string; init?: RequestInit }[];
  redirects: string[];
  configure: () => Promise<void>;
  unmount: () => Promise<void>;
}) => Promise<void>, screen: "test" | "sign-in" = "test") {
  const route = screen === "test" ? "/sso/test?intentId=intent-fixture&organizationId=org-fixture" : "/sso/org-fixture";
  GlobalRegistrator.register({ url: `https://app.example.test${route}` });
  const priorActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const config = deferred<runtime.DenWebRuntimeConfig>();
  spyOn(runtime, "getRuntimeConfig").mockReturnValue(config.promise);
  spyOn(navigation, "useSearchParams").mockReturnValue(new navigation.ReadonlyURLSearchParams(window.location.search));
  spyOn(navigation, "useParams").mockReturnValue({ orgSlug: "org-fixture" });
  const calls: { input: string; init?: RequestInit }[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push({ input: String(input), init });
    return Response.json({ url: idpUrl });
  });
  const redirects: string[] = [];
  spyOn(window.location, "assign").mockImplementation((url) => { redirects.push(String(url)); });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    await act(async () => { root.unmount(); });
    mounted = false;
  };
  try {
    await act(async () => {
      const page = screen === "test" ? <SsoTestStartPage /> : <OrganizationSsoSignInPage />;
      root.render(strict ? <StrictMode>{page}</StrictMode> : page);
    });
    await check({
      calls,
      redirects,
      configure: async () => {
        await act(async () => { config.resolve(runtime.EMPTY_RUNTIME_CONFIG); });
      },
      unmount,
    });
  } finally {
    await unmount();
    mock.restore();
    if (priorActEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", priorActEnvironment);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    await GlobalRegistrator.unregister();
  }
}

test.each([false, true])("SSO test reaches the IdP after runtime config, strict replay=%s", async (strict) => {
  await withSsoPage(strict, async ({ calls, redirects, configure }) => {
    expect(calls).toEqual([]);
    await configure();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      input: "/api/browser/v1/sso/test/intent-fixture/start",
      init: expect.objectContaining({ method: "POST", credentials: "include", headers: expect.objectContaining({ "x-openwork-legacy-org-id": "org-fixture" }) }),
    });
    expect(redirects).toEqual([idpUrl]);
  });
});

test("an unmounted SSO test does not start an IdP handoff after configuration resolves", async () => {
  await withSsoPage(true, async ({ calls, redirects, configure, unmount }) => {
    await unmount();
    await configure();
    expect(calls).toEqual([]);
    expect(redirects).toEqual([]);
  });
});

for (const strict of [false, true]) {
  test(`SSO sign-in issues one OAuth challenge with ${strict ? "replayed" : "normal"} effects`, async () => {
    await withSsoPage(strict, async ({ calls, redirects, configure }) => {
      expect(calls).toEqual([]);
      await configure();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        input: "/api/auth/sign-in/sso",
        init: expect.objectContaining({ method: "POST", credentials: "include" }),
      });
      expect(redirects).toEqual([idpUrl]);
    }, "sign-in");
  });
}

test("an unmounted SSO sign-in does not create an OAuth challenge", async () => {
  await withSsoPage(true, async ({ calls, redirects, configure, unmount }) => {
    await unmount();
    await configure();
    expect(calls).toEqual([]);
    expect(redirects).toEqual([]);
  }, "sign-in");
});
