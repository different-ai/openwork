import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { NextRequest } from "next/server";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { denApiCredentialsForEndpoint, denApiEndpointForWebOrigin, denApiOriginForWebOrigin, setDenApiOriginOverride } from "../app/(den)/_lib/den-api-origin";
import * as runtime from "../app/(den)/_lib/runtime-config";
import { redirectToDenApi } from "../app/api/_lib/den-api-redirect";
import McpConsentPage from "../app/mcp/consent/page";
import McpSelectOrganizationPage from "../app/mcp/select-organization/page";

const ENV_KEYS = ["DEN_API_BASE", "DEN_API_PUBLIC_URL"] as const;
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  setDenApiOriginOverride(null);
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Den API browser origin", () => {
  test("prefixes the hosted app origin with the api subdomain", () => {
    expect(denApiOriginForWebOrigin("https://app.openworklabs.com")).toBe("https://api.app.openworklabs.com");
  });

  test("prefixes custom web hosts with the api subdomain", () => {
    expect(denApiOriginForWebOrigin("https://den.example.com")).toBe("https://api.den.example.com");
  });

  test("leaves existing api hosts stable", () => {
    expect(denApiOriginForWebOrigin("https://api.openworklabs.com")).toBe("https://api.openworklabs.com");
  });

  test("sends browsers to DEN_API_PUBLIC_URL, not the in-network DEN_API_BASE upstream", () => {
    process.env.DEN_API_BASE = "http://den:8788";
    process.env.DEN_API_PUBLIC_URL = "http://localhost:18788/";

    expect(denApiOriginForWebOrigin("http://localhost:13005")).toBe("http://localhost:18788");

    const request = new NextRequest("http://localhost:13005/api/den/health");
    const response = redirectToDenApi(request, "/api/den");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:18788/health");
    expect(response.headers.get("location")).not.toContain("den:8788");
  });

  test("keeps the documented DEN_API_BASE fallback when no public URL is configured", () => {
    process.env.DEN_API_BASE = "http://127.0.0.1:8790";
    delete process.env.DEN_API_PUBLIC_URL;

    expect(denApiOriginForWebOrigin("http://localhost:3005")).toBe("http://127.0.0.1:8790");
  });

  test("skips a DEN_API_PUBLIC_URL without a scheme and falls back like the build-time rule", () => {
    process.env.DEN_API_BASE = "http://den:8788";
    process.env.DEN_API_PUBLIC_URL = "localhost:18788";

    expect(denApiOriginForWebOrigin("http://localhost:13005")).toBe("http://den:8788");
  });

  test("builds direct API URLs instead of same-origin Den proxy URLs", () => {
    expect(denApiEndpointForWebOrigin("/v1/me", "https://app.openworklabs.com")).toBe("https://api.app.openworklabs.com/v1/me");
  });

  test("uses the runtime-config API origin override when present", () => {
    setDenApiOriginOverride("https://api.override.example.test/v1/ignored");

    expect(denApiEndpointForWebOrigin("/v1/me", "https://app.openworklabs.com")).toBe("https://api.override.example.test/v1/me");
    expect(denApiCredentialsForEndpoint("https://api.override.example.test/v1/me", "https://app.openworklabs.com")).toBe("include");
  });

  test("redirects legacy app/proxy MCP callbacks to the direct API callback path", () => {
    const request = new NextRequest(
      "https://app.openworklabs.com/api/den/v1/mcp-connections/oauth/callback?code=abc&state=opaque",
    );
    const response = redirectToDenApi(request, "/api/den");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://api.app.openworklabs.com/v1/mcp-connections/oauth/callback?code=abc&state=opaque",
    );
  });

  test("builds direct API URLs for Better Auth traffic", () => {
    expect(denApiEndpointForWebOrigin("/api/auth/sign-in/email", "https://app.openworklabs.com")).toBe(
      "https://api.app.openworklabs.com/api/auth/sign-in/email",
    );
    expect(denApiEndpointForWebOrigin("/api/auth/callback/google?code=provider-token", "https://app.openworklabs.com")).toBe(
      "https://api.app.openworklabs.com/api/auth/callback/google?code=provider-token",
    );
  });

  test("includes cookies for same-site direct API-origin browser requests", () => {
    expect(denApiCredentialsForEndpoint("https://api.app.openworklabs.com/v1/me", "https://app.openworklabs.com")).toBe("include");
    expect(denApiCredentialsForEndpoint("/api/runtime-config", "https://app.openworklabs.com")).toBe("include");
    expect(denApiCredentialsForEndpoint("https://external.example.com/v1/me", "https://app.openworklabs.com")).toBe("omit");
  });

  test("omits cookies for public direct API endpoints", () => {
    expect(denApiCredentialsForEndpoint(
      "https://api.app.openworklabs.com/v1/orgs/sso/resolve?email=omar%40openworklabs.com",
      "https://app.openworklabs.com",
      "/v1/orgs/sso/resolve?email=omar%40openworklabs.com",
    )).toBe("omit");
  });
});

const consentPages = [
  { name: "consent authorization", page: McpConsentPage, route: "consent", button: "Authorize", path: "/api/auth/oauth2/consent" },
  { name: "consent denial", page: McpConsentPage, route: "consent", button: "Deny", path: "/api/auth/oauth2/consent" },
  { name: "organization selection", page: McpSelectOrganizationPage, route: "select-organization", button: null, path: "/v1/me/orgs" },
];

test.each(consentPages)("fresh $name waits for runtime configuration and keeps the web session cookie", async ({ page, route, button, path }) => {
  const apiOrigin = "https://api-portal.example.test";
  GlobalRegistrator.register({ url: `https://portal.example.test/mcp/${route}?client_id=test-client&scope=mcp%3Aread` });
  const previousActEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  delete process.env.DEN_API_BASE;
  delete process.env.DEN_API_PUBLIC_URL;
  setDenApiOriginOverride(null);

  let resolveConfig: (config: runtime.DenWebRuntimeConfig) => void = () => { throw new Error("Runtime config not initialized"); };
  const config = new Promise<runtime.DenWebRuntimeConfig>((resolve) => { resolveConfig = resolve; });
  const loadConfig = spyOn(runtime, "getRuntimeConfig").mockImplementation(async () => {
    const result = await config;
    setDenApiOriginOverride(result.denApiUrl);
    return result;
  });
  const fetchRequest = spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ message: "Request observed" }, { status: 400 }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(page)); });
    if (button) {
      const control = Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.trim() === button);
      if (!control) throw new Error(`Missing ${button} button`);
      await act(async () => { control.click(); });
    }

    expect(fetchRequest).not.toHaveBeenCalled();
    expect(loadConfig).toHaveBeenCalledTimes(1);
    await act(async () => { resolveConfig({ ...runtime.EMPTY_RUNTIME_CONFIG, denApiUrl: apiOrigin }); });

    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(fetchRequest).toHaveBeenCalledWith(path.startsWith("/api/auth/") ? path : `/api/browser${path}`, expect.objectContaining({
      credentials: "include",
      method: button ? "POST" : "GET",
    }));
  } finally {
    await act(async () => { root.unmount(); });
    fetchRequest.mockRestore();
    loadConfig.mockRestore();
    if (previousActEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    await GlobalRegistrator.unregister();
  }
});
