import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { POST } from "../app/r/[id]/launch/route.ts";

test("launch rejects cross-site requests before looking up reports or creating VMs", async () => {
  const response = await POST(new Request("https://review.example/r/test/launch", {
    method: "POST", headers: { origin: "https://unrelated.example" },
  }), { params: Promise.resolve({ id: "a".repeat(32) }) });
  assert.equal(response.status, 403);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("launch fails closed when disconnected, and refuses missing reports when connected", async () => {
  const savedKey = process.env.FREESTYLE_API_KEY;
  const savedDirectory = process.env.OPENWORK_REVIEW_LOCAL_DIR;
  const directory = await mkdtemp(join(tmpdir(), "openwork-review-launch-"));
  const request = () => new Request("https://review.example/r/test/launch", { method: "POST", headers: { origin: "https://review.example" } });
  const params = { params: Promise.resolve({ id: "a".repeat(32) }) };
  try {
    delete process.env.FREESTYLE_API_KEY;
    assert.equal((await POST(request(), params)).status, 503);
    process.env.FREESTYLE_API_KEY = "synthetic-not-a-real-key";
    process.env.OPENWORK_REVIEW_LOCAL_DIR = directory;
    assert.equal((await POST(request(), params)).status, 404);
  } finally {
    if (savedKey === undefined) delete process.env.FREESTYLE_API_KEY;
    else process.env.FREESTYLE_API_KEY = savedKey;
    if (savedDirectory === undefined) delete process.env.OPENWORK_REVIEW_LOCAL_DIR;
    else process.env.OPENWORK_REVIEW_LOCAL_DIR = savedDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-origin check honors the requested host behind Next's local URL normalization", async () => {
  const saved = process.env.FREESTYLE_API_KEY;
  delete process.env.FREESTYLE_API_KEY;
  try {
    const response = await POST(new Request("http://localhost:3011/r/test/launch", {
      method: "POST", headers: { host: "127.0.0.1:3011", origin: "http://127.0.0.1:3011" },
    }), { params: Promise.resolve({ id: "a".repeat(32) }) });
    assert.equal(response.status, 503);
  } finally { if (saved !== undefined) process.env.FREESTYLE_API_KEY = saved; }
});
