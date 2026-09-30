import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { requestJson } from "../app/(den)/_lib/den-flow.ts";
import { setDenApiOriginOverride } from "../app/(den)/_lib/den-api-origin.ts";
import * as runtime from "../app/(den)/_lib/runtime-config.ts";

const previousWindow = globalThis.window;
const previousFetch = globalThis.fetch;
const webOrigin = "https://portal.example.test";
const apiOrigin = "https://api-portal.example.test";
let loadConfig;

beforeEach(() => {
  setDenApiOriginOverride(apiOrigin);
  loadConfig = spyOn(runtime, "getRuntimeConfig").mockResolvedValue({ ...runtime.EMPTY_RUNTIME_CONFIG, denApiUrl: apiOrigin });
  globalThis.window = {
    location: { origin: webOrigin },
    localStorage: { getItem: () => null, setItem: () => { throw new Error("Cookie-only sessions must not persist a bearer token"); } },
  };
});

afterEach(() => {
  loadConfig.mockRestore();
  setDenApiOriginOverride(null);
  globalThis.fetch = previousFetch;
  if (previousWindow === undefined) {
    delete globalThis.window;
  } else {
    globalThis.window = previousWindow;
  }
});

describe("Den browser session routing", () => {
  test("hydrates a cookie-only session and its organizations on the web origin", async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), webOrigin);
      calls.push({ path: url.pathname, origin: url.origin, authorization: init.headers.get("authorization") });
      // Model a host-only browser cookie: the sibling API cannot receive it.
      if (url.origin !== webOrigin || init.credentials !== "include") return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname === "/api/browser/v1/me") return Response.json({ user: { id: "member-1" } });
      if (url.pathname === "/api/browser/v1/me/orgs") return Response.json({ orgs: [{ id: "org-1" }] });
      throw new Error(`Unexpected browser request: ${url.pathname}`);
    };

    expect((await requestJson("/v1/me", { method: "GET" })).payload).toEqual({ user: { id: "member-1" } });
    expect((await requestJson("/v1/me/orgs", { method: "GET" })).payload).toEqual({ orgs: [{ id: "org-1" }] });
    expect(calls).toEqual([
      { path: "/api/browser/v1/me", origin: webOrigin, authorization: null },
      { path: "/api/browser/v1/me/orgs", origin: webOrigin, authorization: null },
    ]);
  });

  test("clears Better Auth session cookies only after the same-origin session is unauthorized", async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), credentials: init?.credentials, method: init?.method });
      if (String(input) === "/api/browser/v1/me") return Response.json({ error: "unauthorized" }, { status: 401 });
      return Response.json({ ok: true });
    };

    const { response } = await requestJson("/v1/me", { method: "GET" }, 12000);

    expect(response.status).toBe(401);
    expect(calls).toEqual([
      { input: "/api/browser/v1/me", credentials: "include", method: "GET" },
      { input: "/api/auth/clear-session-cookie", credentials: "include", method: "POST" },
    ]);
  });

  test("does not clear the session or retry a write on the API origin after a proxy timeout", async () => {
    const calls = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return Response.json({ error: "upstream_timeout" }, { status: 504 });
    };
    expect((await requestJson("/v1/me", { method: "GET" })).response.status).toBe(504);
    expect((await requestJson("/v1/me/active-organization", { method: "POST", body: JSON.stringify({ organizationId: "org-1" }) })).response.status).toBe(504);
    expect(calls).toEqual(["/api/browser/v1/me", "/api/browser/v1/me/active-organization"]);
  });

  test("preserves same-origin auth and credential-free public SSO discovery", async () => {
    const calls = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), credentials: init.credentials });
      return Response.json({});
    };
    await requestJson("/api/auth/get-session", { method: "GET" });
    await requestJson("/v1/orgs/sso/resolve?email=member%40example.test", { method: "GET" });
    expect(calls).toEqual([
      { input: "/api/auth/get-session", credentials: "include" },
      { input: `${apiOrigin}/v1/orgs/sso/resolve?email=member%40example.test`, credentials: "omit" },
    ]);
  });
});
