import assert from "node:assert/strict";
import { afterEach, vi } from "vitest";
import { test } from "@openwork/testkit";

import WorkbotPage from "../../ee/apps/den-web/app/(den)/workbot/page";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function expectNavigation(result: Promise<unknown>, digest: string) {
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok("digest" in error);
    assert.equal(error.digest, digest);
    return true;
  });
}

function featureResponse(features: unknown = { workbotConfiguredEntry: true }, deployment = "self_hosted", version = 1) {
  return new Response(JSON.stringify({ version, deployment, features }));
}

function selfHosted(fetcher = vi.fn<typeof fetch>(async () => featureResponse())) {
  vi.stubEnv("DEN_DEPLOYMENT", "self_hosted");
  vi.stubEnv("DEN_WORKBOT_URL", "");
  vi.stubEnv("DEN_API_BASE", "https://api.example.test");
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

const page = () => WorkbotPage({ searchParams: Promise.resolve({ organizationId: "org_local" }) });
const hosted = "NEXT_REDIRECT;replace;https://chat.openworklabs.com/?organization=org_local;307;";

test("the self-hosted entry returns 404 only when canonical deployment discovery enables it", async ({ evidence }) => {
  const fetcher = selfHosted();
  await expectNavigation(page(), "NEXT_HTTP_ERROR_FALLBACK;404");
  assert.equal(fetcher.mock.calls.length, 1);
  const [url, init] = fetcher.mock.calls[0];
  assert.ok(init);
  assert.equal(url, "https://api.example.test/v1/features");
  assert.equal(init.cache, "no-store");
  assert.equal(init.credentials, "omit");
  assert.equal(init.headers, undefined);
  assert.ok(init.signal instanceof AbortSignal);
  evidence.recordAssertionEvidence("configured deployment entry is gated", "The real page invokes notFound only after canonical deployment feature discovery, without session credentials", true);
});

for (const [label, response] of [
  ["off", () => featureResponse({ workbotConfiguredEntry: false })],
  ["missing", () => featureResponse({})],
  ["wrong type", () => featureResponse({ workbotConfiguredEntry: "true" })],
  ["null features", () => featureResponse(null)],
  ["Cloud response", () => featureResponse(undefined, "cloud")],
  ["wrong version", () => featureResponse(undefined, "self_hosted", 2)],
  ["invalid JSON", () => new Response("not JSON")],
  ["HTTP failure", () => new Response("unavailable", { status: 503 })],
] as const) {
  test(`self-hosted discovery ${label} preserves the historical hosted fallback`, async ({ evidence }) => {
    selfHosted(vi.fn(async () => response()));
    await expectNavigation(page(), hosted);
    evidence.recordAssertionEvidence("default-off compatibility", `${label} does not enable the entry rule`, true);
  });
}

for (const name of ["TypeError", "TimeoutError"]) {
  test(`self-hosted discovery ${name} preserves the historical fallback`, async ({ evidence }) => {
    selfHosted(vi.fn(async () => { throw new DOMException("unavailable", name); }));
    await expectNavigation(page(), hosted);
    evidence.recordAssertionEvidence("discovery failure stays off", "Unavailable discovery is not mistaken for an enabled feature", true);
  });
}

for (const base of ["", "not a URL", "file:///local", "https://user:password@api.example.test", "https://api.example.test?query=value", "https://api.example.test#fragment"]) {
  test(`an absent or invalid server API base (${base || "empty"}) stays default-off`, async ({ evidence }) => {
    const fetcher = selfHosted();
    vi.stubEnv("DEN_API_BASE", base);
    await expectNavigation(page(), hosted);
    assert.equal(fetcher.mock.calls.length, 0);
    evidence.recordAssertionEvidence("unconfigured discovery stays off", "The page retains historical fallback without a valid server API base", true);
  });
}

for (const deployment of [undefined, "", "unknown", "cloud"]) {
  test(`the ${deployment ?? "unset"} deployment preserves the hosted redirect without discovery`, async ({ evidence }) => {
    const fetcher = selfHosted();
    vi.stubEnv("DEN_DEPLOYMENT", deployment);
    await expectNavigation(page(), hosted);
    assert.equal(fetcher.mock.calls.length, 0);
    evidence.recordAssertionEvidence("hosted compatibility", "The actual page keeps organization forwarding without adding discovery or requiring new environment settings", true);
  });
}

for (const deployment of [undefined, "unknown", "self_hosted", "cloud"]) {
  test(`the ${deployment ?? "unset"} deployment's explicit Workbot URL bypasses feature discovery`, async ({ evidence }) => {
    const fetcher = selfHosted();
    vi.stubEnv("DEN_DEPLOYMENT", deployment);
    vi.stubEnv("DEN_WORKBOT_URL", "https://manual.example.test/chat?source=den");
    await expectNavigation(page(), "NEXT_REDIRECT;replace;https://manual.example.test/chat?source=den&organization=org_local;307;");
    assert.equal(fetcher.mock.calls.length, 0);
    evidence.recordAssertionEvidence("manual destination wins", "The real page preserves the explicit path/query and organization without discovery", true);
  });
}
