import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { denApiOriginForWebOrigin } from "../app/(den)/_lib/den-api-origin";
import { redirectToDenApi } from "../app/api/_lib/den-api-redirect";
import { readPublicWebOrigin } from "../app/_lib/public-web-origin";
import { denApiRedirectOrigin, denApiRedirects } from "../next-config-den-api-redirects.cjs";

type RedirectEnv = Partial<Record<"DEN_API_BASE" | "DEN_BASE_URL" | "DEN_WEB_PUBLIC_ORIGIN", string>>;

const ENV_KEYS = ["DEN_API_BASE", "DEN_BASE_URL", "DEN_WEB_PUBLIC_ORIGIN"] as const;
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function applyEnv(env: RedirectEnv) {
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Den API build-time redirect rules", () => {
  test("emits no rule when the API origin is only known per request", () => {
    expect(denApiRedirectOrigin({})).toBeNull();
    expect(denApiRedirects({})).toEqual([]);
  });

  test("prefers an explicit DEN_API_BASE origin", () => {
    const env = { DEN_API_BASE: "https://api.openworklabs.com/", DEN_BASE_URL: "https://app.openworklabs.com" };

    expect(denApiRedirectOrigin(env)).toBe("https://api.openworklabs.com");
    expect(denApiRedirects(env)).toEqual([
      {
        source: "/api/den/:path*",
        destination: "https://api.openworklabs.com/:path*",
        permanent: false,
      },
    ]);
  });

  test("derives the api-prefixed host from DEN_BASE_URL", () => {
    expect(denApiRedirectOrigin({ DEN_BASE_URL: "https://app.openworklabs.com" })).toBe("https://api.app.openworklabs.com");
    expect(denApiRedirectOrigin({ DEN_BASE_URL: "den.example.com" })).toBe("https://api.den.example.com");
    expect(denApiRedirectOrigin({ DEN_BASE_URL: "http://api.den.local:8790" })).toBe("http://api.den.local:8790");
  });

  test("falls back to DEN_WEB_PUBLIC_ORIGIN when DEN_BASE_URL is not an origin", () => {
    const env = { DEN_BASE_URL: "https://app.example.com/den", DEN_WEB_PUBLIC_ORIGIN: "https://den.example.org/" };

    expect(denApiRedirectOrigin(env)).toBe("https://api.den.example.org");
  });

  test("ignores a DEN_API_BASE without a scheme, like the route handler", () => {
    const env = { DEN_API_BASE: "api.openworklabs.com", DEN_BASE_URL: "https://app.openworklabs.com" };

    expect(denApiRedirectOrigin(env)).toBe("https://api.app.openworklabs.com");
  });

  test("matches the route handler's Location for every supported env shape", () => {
    const shapes: RedirectEnv[] = [
      { DEN_API_BASE: "https://api.openworklabs.com", DEN_BASE_URL: "https://app.openworklabs.com" },
      { DEN_BASE_URL: "https://app.openworklabs.com" },
      { DEN_BASE_URL: "http://localhost:3005", DEN_API_BASE: "http://127.0.0.1:8790" },
      { DEN_WEB_PUBLIC_ORIGIN: "https://den.example.org" },
      { DEN_API_BASE: "not a url", DEN_BASE_URL: "https://app.openworklabs.com" },
    ];

    for (const shape of shapes) {
      applyEnv(shape);
      const request = new NextRequest("http://den-web:3005/api/den/v1/me?include=org");
      const runtime = redirectToDenApi(request, "/api/den");
      const runtimeLocation = new URL(runtime.headers.get("location") ?? "");
      const buildTime = denApiRedirectOrigin(process.env);

      expect(runtime.status).toBe(307);
      expect(buildTime).toBe(runtimeLocation.origin);
      expect(buildTime).toBe(denApiOriginForWebOrigin(readPublicWebOrigin() ?? "http://den-web:3005"));
      expect(denApiRedirects(process.env)[0]?.destination).toBe(`${runtimeLocation.origin}/:path*`);
    }
  });
});
