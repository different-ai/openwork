import assert from "node:assert/strict";
import { test } from "node:test";
import { ORG_SCOPE_HEADER, setRequestOrgScope } from "../../app/(den)/_lib/org-scope";
import { DIAGNOSTICS_CHECK_PATH, DIAGNOSTICS_PATH } from "./diagnostics-data";
import { report } from "./diagnostics-test-fixtures";
import { readOrgDiagnostics, startOrgDiagnosticsCheck } from "./diagnostics-transport";

type Call = { path: string; init: RequestInit };

async function withFetch(handler: (call: Call) => Response, run: (calls: Call[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const call = { path: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  };
  try { await run(calls); } finally { globalThis.fetch = originalFetch; }
}

test("reads and checks pin the selected organization, never an admin path, and Check now sends no body", async () => {
  setRequestOrgScope("another-org");
  try {
    await withFetch(() => Response.json(report(), { status: 200 }), async (calls) => {
      const controller = new AbortController();
      const read = await readOrgDiagnostics("selected-org", controller.signal);
      assert.equal(read.ok, true);
      const check = await startOrgDiagnosticsCheck("selected-org");
      assert.deepEqual(check.ok && { rateLimited: check.rateLimited, hasData: check.data !== null }, { rateLimited: false, hasData: true });
      assert.ok(calls[0].path.endsWith(DIAGNOSTICS_PATH));
      assert.ok(calls[1].path.endsWith(DIAGNOSTICS_CHECK_PATH));
      assert.deepEqual(calls.map((call) => call.init.method), ["GET", "POST"]);
      assert.equal(calls[0].init.signal, controller.signal);
      for (const call of calls) {
        assert.equal(call.init.body, undefined);
        assert.equal(new Headers(call.init.headers).get(ORG_SCOPE_HEADER), "selected-org");
        assert.ok(!call.path.includes("/admin/"));
        assert.ok(!call.path.includes("strict"));
      }
    });
  } finally { setRequestOrgScope(null); }
});

test("a rate-limited check keeps its body and a bounded Retry-After", async () => {
  await withFetch(() => Response.json(report({ checking: true }), { status: 429, headers: { "Retry-After": "17" } }), async () => {
    const result = await startOrgDiagnosticsCheck("org");
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.rateLimited, true);
    assert.equal(result.retryAfterSeconds, 17);
    assert.equal(result.data?.checking, true);
  });
  await withFetch(() => Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" } }), async () => {
    const result = await startOrgDiagnosticsCheck("org");
    assert.deepEqual(result, { ok: true, rateLimited: true, retryAfterSeconds: undefined, data: null });
  });
});

test("failures map to a fixed status and never carry server text or URLs", async () => {
  const cases = [[401, "signed_out"], [403, "forbidden"], [404, "unsupported"], [500, "error"], [503, "error"]] as const;
  for (const [status, failure] of cases) {
    await withFetch(() => Response.json({ error: "x", message: "https://private.example.test/secret" }, { status }), async () => {
      const read = await readOrgDiagnostics("org");
      assert.deepEqual(read, { ok: false, failure, status });
      const check = await startOrgDiagnosticsCheck("org");
      assert.deepEqual(check, { ok: false, failure, status });
    });
  }
  await withFetch(() => Response.json({ ...report(), url: "https://private.example.test" }), async () => {
    const read = await readOrgDiagnostics("org");
    assert.deepEqual(read, { ok: false, failure: "error", status: 200 });
  });
});

test("an aborted read stops before and after the request", async () => {
  await withFetch(() => Response.json(report()), async (calls) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readOrgDiagnostics("org", controller.signal));
    assert.equal(calls.length, 0);
  });
  const controller = new AbortController();
  await withFetch(() => { controller.abort(); return Response.json(report()); }, async (calls) => {
    await assert.rejects(readOrgDiagnostics("org", controller.signal));
    assert.equal(calls.length, 1);
  });
});
