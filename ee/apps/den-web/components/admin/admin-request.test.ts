import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { GET, PUT } from "../../app/api/browser/v1/[...path]/route";
import { requestAdmin, sendAdmin } from "./admin-request";

test("structured errors survive the browser proxy and admin transports", async (context) => {
  const upstream = "http://127.0.0.1:18790";
  const previous = process.env.DEN_API_BASE;
  process.env.DEN_API_BASE = upstream;
  context.after(() => {
    if (previous === undefined) delete process.env.DEN_API_BASE;
    else process.env.DEN_API_BASE = previous;
  });
  const path = "/v1/admin/features/managedDeployments";
  const payload = { error: "feature_unavailable", message: "This feature is not available on this deployment." };
  let status = 400;
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(upstream)) {
      assert.equal(url, `${upstream}${path}`);
      return Response.json(payload, { status });
    }
    assert.equal(url, path);
    const proxy = init?.method === "PUT" ? PUT : GET;
    return proxy(new NextRequest(`http://localhost:3005/api/browser${url}`, {
      method: init?.method,
      body: init?.body,
      headers: { origin: "http://localhost:3005", "content-type": "application/json" },
    }));
  });
  for (status of [400, 502]) {
    const sent = await sendAdmin(path, "PUT", { enabled: true });
    assert.equal(sent.ok, false);
    assert.equal(sent.status, status);
    assert.equal(sent.code, payload.error);
    assert.equal(sent.message, payload.message);

    const requested = await requestAdmin(path, () => null);
    assert.equal(requested.access, "error");
    assert.equal(requested.status, status);
    assert.equal(requested.code, payload.error);
    assert.equal(requested.message, payload.message);
  }
});

test("an admin 403 says why Den refused it", async (context) => {
  let payload: unknown = null;
  context.mock.method(globalThis, "fetch", async () => Response.json(payload, { status: 403 }));
  const cases: Array<[unknown, string]> = [
    [{ error: "forbidden" }, "This account is not on the OpenWork admin allowlist."],
    [{ error: "admin_email_unverified" }, "This account's email address is not verified. Verify it, then retry."],
    [{ error: "admin_email_required" }, "This account has no email address to check against the admin allowlist."],
    [{ error: "restricted_action", message: "This action is restricted to platform admins." }, "This action is restricted to platform admins."],
  ];
  for (const [body, message] of cases) {
    payload = body;
    const requested = await requestAdmin("/v1/admin/features", () => true);
    assert.equal(requested.access, "forbidden");
    assert.equal(requested.access === "forbidden" ? requested.message : null, message);
    const sent = await sendAdmin("/v1/admin/features", "POST", {});
    assert.equal(sent.ok ? null : sent.message, message);
  }
});
