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
  expect(html).toContain("OpenWork web app and its local engine");
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
