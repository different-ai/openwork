import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reviewSchema } from "@openwork/review";
import { uploadReview } from "@openwork/review/storage";
import { POST } from "../app/r/[id]/checkpoint/[evidenceId]/route.ts";

const sha = "a".repeat(40);
const imageHash = "b".repeat(64);
function report(expired = false) {
  const capturedAt = new Date(Date.now() - 3600_000).toISOString();
  return reviewSchema.parse({ schemaVersion: 1, title: "Checkpoint reference", gitSha: sha, createdAt: capturedAt, gaps: [],
    sources: [{ id: "source", kind: "docshot", name: "Reference", gitSha: sha, createdAt: capturedAt, asset: "source.json" }],
    sections: [{ id: "section", sourceId: "source", title: "Reference", evidenceIds: ["picture"] }],
    evidence: [{ id: "picture", sourceId: "source", kind: "image", asset: `${imageHash}.png`, caption: "Reference", description: "", judgments: [],
      checkpoint: { version: 1, provider: "freestyle", id: `ow-evidence-v1-${"c".repeat(32)}`, sourceSha: sha, imageHash,
        capturedAt, expiresAt: new Date(Date.now() + (expired ? -1000 : 3600_000)).toISOString() } }],
  });
}

test("checkpoint metadata must match the exact report commit and image bytes", () => {
  const value = report();
  const image = value.evidence[0]; assert.equal(image.kind, "image");
  if (image.kind !== "image" || !image.checkpoint) throw new Error("Missing test fixture");
  image.checkpoint.sourceSha = "d".repeat(40);
  assert.equal(reviewSchema.safeParse(value).success, false);
  image.checkpoint.sourceSha = sha; image.asset = "different.png";
  assert.equal(reviewSchema.safeParse(value).success, false);
});

test("cross-origin checkpoint requests are rejected before reading the report", async () => {
  const response = await POST(new Request("https://review.example/r/a/checkpoint/picture", { method: "POST", headers: { origin: "https://unrelated.example" } }),
    { params: Promise.resolve({ id: "a".repeat(32), evidenceId: "picture" }) });
  assert.equal(response.status, 403);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("expired, missing and disconnected checkpoints never allocate a VM", async () => {
  const previousDirectory = process.env.OPENWORK_REVIEW_LOCAL_DIR;
  const previousKey = process.env.FREESTYLE_API_KEY;
  const directory = await mkdtemp(join(tmpdir(), "review-checkpoint-test-"));
  try {
    process.env.OPENWORK_REVIEW_LOCAL_DIR = directory;
    delete process.env.FREESTYLE_API_KEY;
    const assets = [{ name: "source.json", body: Buffer.from("{}") }, { name: `${imageHash}.png`, body: Buffer.from("fixture") }];
    const current = await uploadReview(report(), assets);
    const expired = await uploadReview(report(true), assets);
    const request = () => new Request("https://review.example/r/a/checkpoint/picture", { method: "POST", headers: { origin: "https://review.example" } });
    assert.equal((await POST(request(), { params: Promise.resolve({ id: current, evidenceId: "picture" }) })).status, 503);
    assert.equal((await POST(request(), { params: Promise.resolve({ id: expired, evidenceId: "picture" }) })).status, 410);
    assert.equal((await POST(request(), { params: Promise.resolve({ id: current, evidenceId: "other" }) })).status, 404);
    assert.equal((await POST(request(), { params: Promise.resolve({ id: "0".repeat(32), evidenceId: "picture" }) })).status, 404);
    process.env.FREESTYLE_API_KEY = "synthetic-do-not-call";
    const bad = new Request("https://review.example/r/a/checkpoint/picture", { method: "POST", headers: { origin: "https://review.example" }, body: JSON.stringify({ requestId: "a".repeat(36), snapshotId: "arbitrary" }) });
    assert.equal((await POST(bad, { params: Promise.resolve({ id: current, evidenceId: "picture" }) })).status, 400);
  } finally {
    if (previousKey === undefined) delete process.env.FREESTYLE_API_KEY; else process.env.FREESTYLE_API_KEY = previousKey;
    if (previousDirectory === undefined) delete process.env.OPENWORK_REVIEW_LOCAL_DIR; else process.env.OPENWORK_REVIEW_LOCAL_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
