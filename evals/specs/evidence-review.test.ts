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
  const get = (path: string) =>
    fetch(`${world.baseUrl}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
  const page = await get(`/r/${world.passed}`);
  expect(page.status).toBe(200);
  expect(page.headers.get("www-authenticate")).toBeNull();
  expect(page.headers.get("cache-control")).toContain("private");
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
  expect(
    (await get(`/r/${world.passed}/assets/not-referenced.json`)).status,
  ).toBe(404);
  expect((await get(`/r/${"0".repeat(32)}`)).status).toBe(404);
  evidence.recordAssertionEvidence(
    "Preview pages, images, and source records need no second login",
    "Requests reaching the preview app return the page, image, and original diagnostics without Basic authentication. Responses are private; missing reports and unreferenced assets return 404. Hosted Vercel authentication is verified separately.",
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

  const missingPublication = await world.runPublisher("missing");
  expect(missingPublication.code).not.toBe(0);
  expect(missingPublication.stderr).toContain(
    "INCOMPLETE: no test records for this PR head",
  );
  expect(missingPublication.summary).toContain(
    "## Evidence review — incomplete",
  );
  expect(missingPublication.summary).toContain(
    "no passing evidence is claimed",
  );
  expect(missingPublication.commentWrites).toBe(0);
  expect(missingPublication.uploadWrites).toBe(0);
  expect(missingPublication.commandLog).not.toContain('"comment"');

  const currentPublication = await world.runPublisher("current");
  expect(currentPublication.code).toBe(0);
  expect(currentPublication.stdout).toContain("http://127.0.0.1:4173/r/");
  expect(currentPublication.stderr).not.toContain("INCOMPLETE");
  expect(currentPublication.commentWrites).toBe(1);
  expect(currentPublication.uploadWrites).toBe(1);
  evidence.recordAssertionEvidence(
    "The CI publisher fails closed when exact-head records are missing",
    "The real publisher CLI exits nonzero and writes an Incomplete summary without upload or comment writes when the controlled download has no current-head record; a valid current-head record follows the supported local-storage and PR-comment path.",
    true,
  );

  await using production = await reviewWorld("production");
  for (const path of [
    "/",
    `/r/${production.passed}`,
    `/r/${production.passed}/assets/report.json`,
    `/r/${production.passed}/assets/${image.asset}`,
  ]) {
    const response = await fetch(`${production.baseUrl}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("private");
  }
  evidence.recordAssertionEvidence(
    "Production deployments cannot serve review evidence",
    "The home page, report, JSON, and image routes all return 503 when the app runs in Vercel's production environment, where Standard Protection can leave production domains public.",
    true,
  );
});
