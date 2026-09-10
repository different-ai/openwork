import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

const previousDenBaseUrl = process.env.DEN_BASE_URL;
const previousDenApiBase = process.env.DEN_API_BASE;
const previousDenApiPublicUrl = process.env.DEN_API_PUBLIC_URL;
const previousPublicOrigin = process.env.DEN_WEB_PUBLIC_ORIGIN;

beforeEach(() => {
  delete process.env.DEN_API_PUBLIC_URL;
});

afterEach(() => {
  if (previousDenBaseUrl === undefined) delete process.env.DEN_BASE_URL;
  else process.env.DEN_BASE_URL = previousDenBaseUrl;
  if (previousDenApiBase === undefined) delete process.env.DEN_API_BASE;
  else process.env.DEN_API_BASE = previousDenApiBase;
  if (previousDenApiPublicUrl === undefined) delete process.env.DEN_API_PUBLIC_URL;
  else process.env.DEN_API_PUBLIC_URL = previousDenApiPublicUrl;
  if (previousPublicOrigin === undefined) delete process.env.DEN_WEB_PUBLIC_ORIGIN;
  else process.env.DEN_WEB_PUBLIC_ORIGIN = previousPublicOrigin;
});

describe("Den API redirect compatibility route", () => {
  test("sends browsers to DEN_API_PUBLIC_URL when DEN_API_BASE is an in-network upstream", async () => {
    process.env.DEN_BASE_URL = "http://localhost:13005";
    process.env.DEN_API_BASE = "http://den:8788";
    process.env.DEN_API_PUBLIC_URL = "http://localhost:18788";
    delete process.env.DEN_WEB_PUBLIC_ORIGIN;

    const { GET } = await import("../den/[...path]/route.ts");
    const response = await GET(new NextRequest("http://localhost:13005/api/den/health"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:18788/health");
  });

  test("redirects legacy /api/den callers to the api-prefixed host", async () => {
    delete process.env.DEN_BASE_URL;
    delete process.env.DEN_API_BASE;
    delete process.env.DEN_WEB_PUBLIC_ORIGIN;

    const { GET } = await import("../den/[...path]/route.ts");
    const response = await GET(new NextRequest("https://app.openworklabs.com/api/den/v1/me?include=org"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://api.app.openworklabs.com/v1/me?include=org");
  });

  test("uses DEN_API_BASE when the API has an explicit local origin", async () => {
    process.env.DEN_BASE_URL = "http://localhost:3005";
    process.env.DEN_API_BASE = "http://127.0.0.1:8790";
    delete process.env.DEN_WEB_PUBLIC_ORIGIN;

    const { POST } = await import("../den/[...path]/route.ts");
    const response = await POST(new NextRequest("http://localhost:3005/api/den/v1/auth/desktop-handoff/exchange"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:8790/v1/auth/desktop-handoff/exchange");
  });

  test("uses DEN_BASE_URL when ingress requests arrive on an internal host", async () => {
    process.env.DEN_BASE_URL = "https://app.openworklabs.com";
    delete process.env.DEN_API_BASE;
    delete process.env.DEN_WEB_PUBLIC_ORIGIN;

    const { POST } = await import("../den/[...path]/route.ts");
    const response = await POST(new NextRequest("http://den-web:3005/api/den/v1/workers"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://api.app.openworklabs.com/v1/workers");
  });

  test("keeps double-slash suffixes on the Den API host", async () => {
    delete process.env.DEN_BASE_URL;
    delete process.env.DEN_API_BASE;
    delete process.env.DEN_WEB_PUBLIC_ORIGIN;

    const { POST } = await import("../den/[...path]/route.ts");
    const response = await POST(new NextRequest("https://app.openworklabs.com/api/den//evil.example/path?token=secret"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://api.app.openworklabs.com//evil.example/path?token=secret");
  });
});
