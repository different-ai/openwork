import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { denApiCredentialsForEndpoint, denApiEndpointForWebOrigin, denApiOriginForWebOrigin, setDenApiOriginOverride } from "../app/(den)/_lib/den-api-origin";
import { redirectToDenApi } from "../app/api/_lib/den-api-redirect";

afterEach(() => {
  setDenApiOriginOverride(null);
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
