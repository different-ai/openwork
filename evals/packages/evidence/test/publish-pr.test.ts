import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { composePrComment, publishPr, publishPrRolls } from "../src/publish-pr.ts";
import type { CommandRunner, Fetcher, PrEvidenceSection } from "../src/publish-pr.ts";
import type { PhotoRollRecord } from "../src/schema.ts";

const ROLL_SHA = "1111111111111111111111111111111111111111";
const OTHER_SHA = "2222222222222222222222222222222222222222";

function section(
  slug: string,
  name: string,
  createdAt: string,
  verdict: PrEvidenceSection["verdict"],
  markdown = `## ${name} details`,
): PrEvidenceSection {
  return { slug, name, createdAt, verdict, markdown };
}

test("composePrComment merges a new spec section into the existing sticky comment", () => {
  const first = section("alpha-spec", "Alpha spec", "2026-07-02T10:00:00.000Z", "passed");
  const second = section("beta-spec", "Beta spec", "2026-07-02T11:00:00.000Z", "failed");
  const existing = composePrComment(undefined, first);
  const merged = composePrComment(existing, second);

  assert.match(merged, /## Alpha spec details/);
  assert.match(merged, /## Beta spec details/);
  assert.match(merged, /- ✅ PASSED — \*\*Alpha spec\*\*/);
  assert.match(merged, /- ❌ FAILED — \*\*Beta spec\*\*/);
});

test("composePrComment replaces only a same-slug section and preserves unrelated sections and markers", () => {
  const existing = composePrComment(undefined, [
    section("alpha-spec", "Alpha spec", "2026-07-02T10:00:00.000Z", "failed", "old alpha evidence"),
    section("beta-spec", "Beta spec", "2026-07-02T11:00:00.000Z", "passed", "beta evidence"),
  ]);
  const merged = composePrComment(
    existing,
    section("alpha-spec", "Alpha spec", "2026-07-02T12:00:00.000Z", "passed", "new alpha evidence"),
  );

  assert.doesNotMatch(merged, /old alpha evidence/);
  assert.match(merged, /new alpha evidence/);
  assert.match(merged, /beta evidence/);
  assert.equal(merged.match(/<!-- photo-roll -->/g)?.length, 1);
  assert.equal(merged.match(/<!-- fraimz -->/g)?.length, 1);
  assert.equal(merged.match(/photo-roll-section slug=alpha-spec/g)?.length, 1);
  assert.equal(merged.match(/- ✅ PASSED — \*\*Alpha spec\*\*/g)?.length, 1);
});

test("composePrComment renders a complete summary and stable chronological section order", () => {
  const body = composePrComment(undefined, [
    section("zulu-spec", "Zulu spec", "2026-07-02T12:00:00.000Z", "unvalidated"),
    section("beta-spec", "Beta spec", "2026-07-02T10:00:00.000Z", "failed"),
    section("alpha-spec", "Alpha spec", "2026-07-02T10:00:00.000Z", "passed"),
  ]);

  assert.match(body, /## Testkit evidence/);
  for (const summary of [
    "- ✅ PASSED — **Alpha spec**",
    "- ❌ FAILED — **Beta spec**",
    "- ⚪ UNVALIDATED — **Zulu spec**",
  ]) assert.ok(body.includes(summary));
  assert.ok(body.indexOf("slug=alpha-spec") < body.indexOf("slug=beta-spec"));
  assert.ok(body.indexOf("slug=beta-spec") < body.indexOf("slug=zulu-spec"));
  assert.ok(body.indexOf("Zulu spec**") < body.indexOf("slug=alpha-spec"));
});

function dryRunRecord(dir: string): PhotoRollRecord {
  return {
    name: "Dry run proof",
    dir,
    createdAt: "2026-07-02T10:00:00.000Z",
    closedAt: "2026-07-02T10:01:00.000Z",
    gitSha: ROLL_SHA,
    branch: "feat/proof",
    summary: {
      ok: true,
      totalFrames: 1,
      passedFrames: 1,
      failedFrames: 0,
      unvalidatedFrames: 0,
      passedExpectations: 1,
      failedExpectations: 0,
    },
    frames: [{
      caption: "Dry-run claim",
      fileName: "01-dry-run.png",
      hash: "hash",
      route: "#/dry-run",
      at: "2026-07-02T10:00:00.000Z",
      description: "Visible dry-run state",
      model: "test-model",
      ok: true,
      results: [{ expectation: "Dry run is visible", passed: true, evidence: "Visible" }],
    }],
  };
}

test("publishPr dry-run prints composed markdown without upload or gh calls", async () => {
  const rollDir = await mkdtemp(join(tmpdir(), "openwork-evidence-publish-"));
  try {
    await mkdir(rollDir, { recursive: true });
    await writeFile(join(rollDir, "roll.json"), JSON.stringify(dryRunRecord(rollDir)));
    let commandCalled = false;
    let fetchCalled = false;
    let output = "";
    const exec: CommandRunner = () => {
      commandCalled = true;
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };
    const fetcher: Fetcher = async () => {
      fetchCalled = true;
      throw new Error("unexpected fetch");
    };
    const result = await publishPr(
      { rollDir, dryRun: true },
      { exec, fetch: fetcher, stdout: (markdown) => { output = markdown; } },
    );
    assert.equal(commandCalled, false);
    assert.equal(fetchCalled, false);
    assert.equal(result.posted, false);
    assert.match(output, /<!-- photo-roll -->/);
    assert.match(output, /Dry-run claim/);
    assert.match(output, /Dry run: screenshots were not uploaded/);
  } finally {
    await rm(rollDir, { recursive: true, force: true });
  }
});

test("publishPrRolls skips malformed and stale rolls and composes matching rolls chronologically", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-evidence-publish-all-"));
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  try {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const olderDir = join(root, "2026-07-02T10-00-00-000Z-older-spec");
    const newerDir = join(root, "2026-07-02T12-00-00-000Z-newer-spec");
    const staleDir = join(root, "2026-07-02T11-00-00-000Z-stale-spec");
    const malformedDir = join(root, "2026-07-02T13-00-00-000Z-malformed-spec");
    await Promise.all([olderDir, newerDir, staleDir, malformedDir].map((dir) => mkdir(dir)));
    const older = dryRunRecord(olderDir);
    older.name = "Older spec";
    const newer = dryRunRecord(newerDir);
    newer.name = "Newer spec";
    newer.createdAt = "2026-07-02T12:00:00.000Z";
    const stale = dryRunRecord(staleDir);
    stale.name = "Stale spec";
    stale.gitSha = OTHER_SHA;
    await Promise.all([
      writeFile(join(olderDir, "roll.json"), JSON.stringify(older)),
      writeFile(join(newerDir, "roll.json"), JSON.stringify(newer)),
      writeFile(join(staleDir, "roll.json"), JSON.stringify(stale)),
      writeFile(join(malformedDir, "roll.json"), "{not-json"),
    ]);
    let postedMarkdown = "";
    const messages: string[] = [];
    const exec: CommandRunner = (_command, args, opts) => {
      if (args.includes("headRefOid")) return { status: 0, stdout: JSON.stringify({ headRefOid: ROLL_SHA }), stderr: "" };
      if (args.includes("comments")) return { status: 0, stdout: JSON.stringify({ comments: [] }), stderr: "" };
      if (args.includes("BLOB_READ_WRITE_TOKEN")) return { status: 1, stdout: "", stderr: "missing" };
      postedMarkdown = opts?.input ?? "";
      return { status: 0, stdout: "posted", stderr: "" };
    };
    const result = await publishPrRolls(
      { pr: 17, rollDirs: [malformedDir, newerDir, staleDir, olderDir] },
      { exec, stdout: (message) => messages.push(message) },
    );

    assert.deepEqual(Object.keys(result.urls), [
      "2026-07-02T10-00-00-000Z-older-spec",
      "2026-07-02T12-00-00-000Z-newer-spec",
    ]);
    assert.equal(messages.some((message) => message.includes("unreadable or malformed roll.json")), true);
    assert.equal(messages.some((message) => message.includes("does not match PR head")), true);
    assert.ok(postedMarkdown.indexOf("slug=older-spec") < postedMarkdown.indexOf("slug=newer-spec"));
    assert.match(postedMarkdown, /screenshots not uploaded \(no BLOB_READ_WRITE_TOKEN\)/);
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("publishPr refuses a symlinked frame before calling the blob uploader", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-evidence-symlink-frame-"));
  const rollDir = join(root, "roll");
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await mkdir(rollDir);
    await writeFile(join(rollDir, "roll.json"), JSON.stringify(dryRunRecord(rollDir)));
    const outsideFile = join(root, "private-key");
    await writeFile(outsideFile, "private material");
    await symlink(outsideFile, join(rollDir, "01-dry-run.png"));
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    let fetchCalled = false;
    const fetcher: Fetcher = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ url: "https://example.test/unexpected.png" }));
    };
    const exec: CommandRunner = (_command, args) => ({
      status: 0,
      stdout: args.includes("headRefOid") ? JSON.stringify({ headRefOid: ROLL_SHA }) : "",
      stderr: "",
    });
    await assert.rejects(
      () => publishPr({ pr: 17, rollDir }, { exec, fetch: fetcher }),
      /Refusing to upload non-regular or symlinked roll frame: 01-dry-run\.png/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test("publishPr publishes when the roll SHA matches the PR head SHA", async () => {
  const rollDir = await mkdtemp(join(tmpdir(), "openwork-evidence-regular-frame-"));
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await writeFile(join(rollDir, "roll.json"), JSON.stringify(dryRunRecord(rollDir)));
    await writeFile(join(rollDir, "01-dry-run.png"), Buffer.from("regular png"));
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    let fetchCalls = 0;
    const fetcher: Fetcher = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ url: "https://example.test/regular.png" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const exec: CommandRunner = (_command, args) => {
      if (args.includes("headRefOid")) return { status: 0, stdout: JSON.stringify({ headRefOid: ROLL_SHA }), stderr: "" };
      return {
        status: 0,
        stdout: args.includes("comments") ? JSON.stringify({ comments: [] }) : "posted",
        stderr: "",
      };
    };
    const result = await publishPr({ pr: 17, rollDir }, { exec, fetch: fetcher });
    assert.equal(fetchCalls, 1);
    assert.equal(result.posted, true);
    assert.equal(result.updated, false);
    assert.equal(result.urls["01-dry-run.png"], "https://example.test/regular.png");
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    await rm(rollDir, { recursive: true, force: true });
  }
});

test("publishPr refuses a roll whose SHA does not match the PR head", async () => {
  const rollDir = await mkdtemp(join(tmpdir(), "openwork-evidence-stale-"));
  try {
    await writeFile(join(rollDir, "roll.json"), JSON.stringify(dryRunRecord(rollDir)));
    let fetchCalled = false;
    const exec: CommandRunner = (_command, args) => ({
      status: 0,
      stdout: args.includes("headRefOid") ? JSON.stringify({ headRefOid: OTHER_SHA }) : "",
      stderr: "",
    });
    await assert.rejects(
      () => publishPr({ pr: 17, rollDir }, { exec, fetch: async () => { fetchCalled = true; return new Response(); } }),
      new RegExp(`Refusing stale evidence: roll SHA ${ROLL_SHA}, PR head SHA ${OTHER_SHA} \\(\\d+d old\\)`),
    );
    assert.equal(fetchCalled, false);
  } finally {
    await rm(rollDir, { recursive: true, force: true });
  }
});

test("publishPr --force publishes stale evidence with a SHA annotation", async () => {
  const rollDir = await mkdtemp(join(tmpdir(), "openwork-evidence-force-"));
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await writeFile(join(rollDir, "roll.json"), JSON.stringify(dryRunRecord(rollDir)));
    await writeFile(join(rollDir, "01-dry-run.png"), Buffer.from("regular png"));
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    let postedMarkdown = "";
    const exec: CommandRunner = (_command, args, opts) => {
      if (args.includes("headRefOid")) return { status: 0, stdout: JSON.stringify({ headRefOid: OTHER_SHA }), stderr: "" };
      if (args.includes("comments")) return { status: 0, stdout: JSON.stringify({ comments: [] }), stderr: "" };
      postedMarkdown = opts?.input ?? "";
      return { status: 0, stdout: "posted", stderr: "" };
    };
    const fetcher: Fetcher = async () => new Response(JSON.stringify({ url: "https://example.test/frame.png" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await publishPr({ pr: 17, rollDir, force: true }, { exec, fetch: fetcher });
    assert.match(postedMarkdown, /⚠ evidence from 1111111, PR head is 2222222/);
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    await rm(rollDir, { recursive: true, force: true });
  }
});

test("publishPr renders facts without images, skips fact uploads, marks failures, and reports verdict math", async () => {
  const rollDir = await mkdtemp(join(tmpdir(), "openwork-evidence-red-facts-"));
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const roll = dryRunRecord(rollDir);
    roll.summary = {
      ok: false,
      totalFrames: 3,
      passedFrames: 2,
      failedFrames: 1,
      unvalidatedFrames: 0,
      passedExpectations: 2,
      failedExpectations: 1,
    };
    roll.frames.push(
      {
        caption: "Broken state",
        fileName: "02-failed.png",
        hash: "failed-hash",
        route: "#/failed",
        at: roll.createdAt,
        description: "The broken state is visible",
        model: "test-model",
        ok: false,
        results: [{ expectation: "State works", passed: false, evidence: "Error banner visible" }],
      },
      {
        caption: "API witness",
        fileName: "",
        hash: "fact-hash",
        route: "",
        at: roll.createdAt,
        description: "The API returned HTTP 500.",
        model: "test-model",
        ok: true,
        results: [{ expectation: "API witness", passed: true, evidence: "HTTP 500 observed" }],
      },
    );
    await writeFile(join(rollDir, "roll.json"), JSON.stringify(roll));
    await Promise.all([
      writeFile(join(rollDir, "01-dry-run.png"), Buffer.from("pass png")),
      writeFile(join(rollDir, "02-failed.png"), Buffer.from("fail png")),
    ]);
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    const uploaded: string[] = [];
    let postedMarkdown = "";
    const fetcher: Fetcher = async (input) => {
      uploaded.push(String(input));
      return new Response(JSON.stringify({ url: `https://example.test/${uploaded.length}.png` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const exec: CommandRunner = (_command, args, opts) => {
      if (args.includes("headRefOid")) return { status: 0, stdout: JSON.stringify({ headRefOid: ROLL_SHA }), stderr: "" };
      if (args.includes("comments")) return { status: 0, stdout: JSON.stringify({ comments: [] }), stderr: "" };
      postedMarkdown = opts?.input ?? "";
      return { status: 0, stdout: "posted", stderr: "" };
    };
    await publishPr({ pr: 17, rollDir }, { exec, fetch: fetcher });
    assert.equal(uploaded.length, 2);
    assert.equal(uploaded.some((url) => url.endsWith("/")), false);
    assert.match(postedMarkdown, /<!-- fraimz -->/);
    assert.match(postedMarkdown, /1\/2 frames passed · 1 fact/);
    assert.match(postedMarkdown, /❌ FAIL — 2\. Broken state/);
    assert.match(postedMarkdown, /ℹ️ FACT — 3\. API witness/);
    assert.match(postedMarkdown, /The API returned HTTP 500/);
    assert.doesNotMatch(postedMarkdown, /alt="API witness"/);
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    await rm(rollDir, { recursive: true, force: true });
  }
});

test("publishPr reports gh authentication guidance when the PR head cannot be resolved", async () => {
  const rollDir = await mkdtemp(join(tmpdir(), "openwork-evidence-gh-auth-"));
  try {
    await writeFile(join(rollDir, "roll.json"), JSON.stringify(dryRunRecord(rollDir)));
    const exec: CommandRunner = () => ({ status: 1, stdout: "", stderr: "not logged in" });
    await assert.rejects(
      () => publishPr({ pr: 17, rollDir }, { exec }),
      /Unable to resolve PR head SHA with gh: not logged in.*gh auth login/,
    );
  } finally {
    await rm(rollDir, { recursive: true, force: true });
  }
});
