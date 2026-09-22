import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { reviewWorld } from "../worlds/evidence-review.ts";

test("reviewers see Freestyle scope and recoverable setup without exposing sandbox access", async ({ evidence }) => {
  await using world = await reviewWorld();
  const page = await fetch(`${world.baseUrl}/r/${world.passed}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Launch in Freestyle");
  expect(html).toContain("Freestyle is not connected");
  expect(html).toContain("Sandbox details");
  expect(html).toContain("ACME web");
  expect(html).toContain("Full stack");
  expect(html).toContain("Your own URLs, workspace, and data. Teammates get separate sandboxes.");
  expect(html).toContain("OpenWork web app and its local engine");
  expect(html).toContain("Sandboxes expire after two hours; work is not saved.");
  expect(html).not.toContain("Open sandbox");
  expect(html).not.toContain("Your connection details");
  expect(html).not.toContain("__openwork_launch?token=");
  evidence.recordAssertionEvidence(
    "A review offers a scoped Freestyle preview with an honest disconnected state",
    "The production review page keeps Launch in Freestyle visible, names the missing connection and owner, explains the OpenWork web scope in collapsed details, and contains no sandbox access link before launch.",
    true,
  );

  const endpoint = `${world.baseUrl}/r/${world.passed}/launch`;
  const disconnected = await fetch(endpoint, { method: "POST", headers: { origin: world.baseUrl } });
  expect(disconnected.status).toBe(503);
  expect(disconnected.headers.get("cache-control")).toContain("no-store");
  expect(await disconnected.json()).toEqual({ error: "Freestyle is not connected. The review app owner can configure it." });
  const crossSite = await fetch(endpoint, { method: "POST", headers: { origin: "https://unrelated.example" } });
  expect(crossSite.status).toBe(403);
  evidence.recordAssertionEvidence(
    "Unavailable and cross-site launches cannot allocate a sandbox",
    "A same-origin launch without credentials returns an actionable 503 with no-store caching; a third-party origin returns 403. This proof uses no provider credentials and does not claim a live Freestyle launch.",
    true,
  );
});

test("a connected review offers both worlds but rejects unsafe launch requests before creating a sandbox", async ({ evidence }) => {
  await using world = await reviewWorld("preview", { connected: true });
  const page = await fetch(`${world.baseUrl}/r/${world.passed}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("OpenWork web");
  expect(html).toContain("ACME web · Full stack");
  expect(html).toContain("Fresh sandbox per launch · 2-hour lifetime");
  expect(html).not.toContain("Freestyle is not connected");
  expect(html).not.toContain("__openwork_launch?token=");
  evidence.recordAssertionEvidence(
    "Connected reviewers can choose a world and understand the sandbox lifetime",
    "The production-built review page offers OpenWork web and ACME full stack, explains that every launch is fresh and expires after two hours, and reveals no access credentials before launch.",
    true,
  );

  const endpoint = `${world.baseUrl}/r/${world.passed}/launch`;
  const post = (url: string, origin: string, body: string) => fetch(url, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const invalidWorld = await post(endpoint, world.baseUrl, JSON.stringify({ world: "production" }));
  expect(invalidWorld.status).toBe(400);
  expect(invalidWorld.headers.get("cache-control")).toContain("no-store");
  expect(await invalidWorld.json()).toEqual({ error: "Choose OpenWork web or ACME web." });
  const malformed = await post(endpoint, world.baseUrl, "{");
  expect(malformed.status).toBe(400);
  const missing = await post(`${world.baseUrl}/r/${"0".repeat(32)}/launch`, world.baseUrl, JSON.stringify({ world: "acme-web" }));
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "Review not found." });
  const crossSite = await post(endpoint, "https://unrelated.example", JSON.stringify({ world: "acme-web" }));
  expect(crossSite.status).toBe(403);
  for (const response of [invalidWorld, malformed, missing, crossSite]) {
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  evidence.recordAssertionEvidence(
    "Invalid worlds, unknown reports, and cross-site actions never allocate a VM",
    "With a synthetic connection, the real launch endpoint rejected an unsupported world and malformed input with 400, an unknown report with 404, and a foreign origin with 403. Every response used no-store caching. The synthetic key is never sent to Freestyle.",
    true,
  );
});
