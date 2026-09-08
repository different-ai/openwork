import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";
import { reviewWorld } from "../worlds/evidence-review.ts";

test("A reviewer can inspect two runs and a DocShot with honest results and private evidence", async ({
  evidence,
}) => {
  needs({ optIn: ["OPENWORK_EVAL_REVIEW"] });
  await using world = await reviewWorld();
  console.log(
    "placement: local (isolated production review app; no external services)",
  );
  const get = (path: string, authenticated = true) =>
    fetch(`${world.baseUrl}${path}`, {
      headers: authenticated ? world.headers : {},
      signal: AbortSignal.timeout(10_000),
    });
  const page = await get(`/r/${world.passed}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Sharing a skill, from link to access");
  expect(html).toContain("A shared skill can be opened");
  expect(html).toContain("The owner can revoke a link");
  expect(html).toContain("Documentation reference");
  expect(html).toContain("badge passed");
  expect(html).not.toContain("UNVALIDATED");
  expect(html).not.toContain("internal diagnostics fixture");
  expect(html).toContain("<details");
  evidence.recordAssertionEvidence(
    "Multiple runs and DocShot compose into one readable review",
    "The production page contains both run sections and the documentation reference; it shows Passed, hides raw diagnostics, and gives reference images no unvalidated label.",
    true,
  );

  const source = world.report.sources[0];
  const image = world.report.evidence.find((item) => item.kind === "image");
  if (!source || image?.kind !== "image")
    throw new Error("Missing expected review evidence.");
  const mediaPath = `/r/${world.passed}/assets/${image.asset}`;
  const media = await get(mediaPath);
  expect(media.status).toBe(200);
  expect(media.headers.get("content-type")).toBe("image/png");
  expect(media.headers.get("cache-control")).toContain("private");
  expect((await media.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  const original = await get(`/r/${world.passed}/assets/${source.asset}`);
  expect(await original.text()).toContain("internal diagnostics fixture");
  expect((await get(`/r/${world.passed}`, false)).status).toBe(401);
  expect((await get(mediaPath, false)).status).toBe(401);
  expect(
    (await get(`/r/${world.passed}/assets/${source.asset}`, false)).status,
  ).toBe(401);
  expect(
    (await get(`/r/${world.passed}/assets/not-referenced.json`)).status,
  ).toBe(404);
  expect((await get(`/r/${"0".repeat(32)}`)).status).toBe(404);
  evidence.recordAssertionEvidence(
    "The same access boundary protects pages, images, and source records",
    "Authenticated requests return the image and original diagnostics. Anonymous requests return 401 for all three; missing reports and unreferenced assets return 404.",
    true,
  );

  const incomplete = await (await get(`/r/${world.incomplete}`)).text();
  expect(incomplete).toContain("badge incomplete");
  expect(incomplete).toContain(
    "Desktop restart remains outside this selected evidence.",
  );
  expect(incomplete).toContain("visual judgment(s) pending");
  expect(incomplete).toContain("Execution ");
  expect(incomplete).toContain("skipped");
  expect(incomplete).not.toContain("badge passed");
  const failed = await (await get(`/r/${world.failed}`)).text();
  expect(failed).toContain("badge failed");
  expect(failed).toContain("result failed");
  expect(failed).not.toContain("badge passed");
  const reference = await (await get(`/r/${world.reference}`)).text();
  expect(reference).toContain("badge reference");
  expect(reference).not.toContain("badge passed");
  evidence.recordAssertionEvidence(
    "Incomplete, failed, and reference evidence cannot become a passing report",
    "A skipped run, declared gap, and pending visual check render Incomplete; a failed assertion overrides passed execution; a DocShot-only report renders Reference.",
    true,
  );
});
