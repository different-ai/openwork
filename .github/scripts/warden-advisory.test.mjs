import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { main } from "./warden-clearance.mjs";

const head = "a".repeat(40);
const env = {
  GH_TOKEN: "test-only", APP_SLUG: "diff-warden", REPO: "example/repo",
  RUN_ID: "99", RUN_ATTEMPT: "1", HEAD_SHA: head,
  RUN_URL: "https://example.test/run", CONCLUSION: "success",
  PULL_REQUESTS: JSON.stringify([{ number: 7, head: { sha: head } }]),
};
function receipt(security, confidentiality) {
  return {
    schema_version: 2, repository: env.REPO, run_id: "99", run_attempt: 1,
    head_sha: head, pr: 7, review_complete: true, incomplete_reasons: [],
    skills: [["diff-security-review", security], ["confidentiality-review", confidentiality]].map(([name, n]) => ({
      name, status: "complete", findings_count: n,
      findings_by_severity: { high: n, medium: 0, low: 0 },
    })),
  };
}

test("PR reporting never submits or dismisses reviews, including clean and flagged heads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "warden-advisory-"));
  const originalFetch = globalThis.fetch;
  try {
    for (const [data, expected] of [[receipt(0, 0), "success"], [receipt(1, 0), "neutral"], [receipt(0, 1), "neutral"], [null, "neutral"]]) {
      const path = join(dir, "receipt.json");
      await writeFile(path, JSON.stringify(data));
      const writes = [];
      globalThis.fetch = async (url, options) => {
        const route = new URL(url).pathname.replace(`/repos/${env.REPO}`, "");
        const method = options.method;
        if (method !== "GET") writes.push({ route, method, body: JSON.parse(options.body) });
        let result;
        if (route === "/pulls/7") result = { state: "open", head: { sha: head, repo: { full_name: env.REPO } }, base: { repo: { full_name: env.REPO } } };
        else if (route === "/pulls/7/files") result = [];
        else if (route === "/issues/7/comments") result = method === "GET" ? [] : {};
        else if (route === "/check-runs") result = {};
        else throw new Error(`Unexpected API operation: ${method} ${route}`);
        return new Response(JSON.stringify(result));
      };
      await main({ ...env, RECEIPT_PATH: path });
      assert.deepEqual(writes.map(({ method, route }) => `${method} ${route}`), ["POST /check-runs", "POST /issues/7/comments"]);
      assert.equal(writes[0].body.conclusion, expected);
      assert.match(writes[1].body.body, /Warden does not block merging or grant or withdraw approvals/);
      assert.doesNotMatch(writes[1].body.body, /### Warden: (not approved|approved)/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("fork test approval and security review do not depend on the Warden AI screen", () => {
  const workflow = readFileSync(new URL("../workflows/contributor-pr-test.yml", import.meta.url), "utf8");
  for (const name of ["start-tests", "review"]) {
    const job = workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0];
    assert.match(job, /needs: authorize\n/);
    assert.doesNotMatch(job, /needs\.ai-screen|needs: \[authorize, ai-screen\]/);
    assert.match(job, /needs\.authorize\.outputs\.sha != ''/);
  }
});
