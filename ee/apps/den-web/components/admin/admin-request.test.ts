import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchAdminChange, setAdminReauthPrompt } from "./admin-request";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setAdminReauthPrompt(null);
});

/** Den refuses the first attempt for an old sign-in, then accepts the change. */
function denAsksForRecentSignInOnce() {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? Response.json({ error: "reauth", reason: "fresh_auth_required", message: "Confirm it's you." }, { status: 403 })
      : Response.json({ ok: true });
  };
  return () => calls;
}

test("an admin change is sent again once the admin confirms their identity", async () => {
  const calls = denAsksForRecentSignInOnce();
  let asked = 0;
  setAdminReauthPrompt(async () => { asked += 1; return true; });
  const response = await fetchAdminChange("/v1/admin/features/example", () => ({ method: "PUT" }));
  assert.deepEqual([response.status, asked, calls()], [200, 1, 2]);
});

test("an admin change is not repeated when the admin cancels", async () => {
  const calls = denAsksForRecentSignInOnce();
  setAdminReauthPrompt(async () => false);
  const response = await fetchAdminChange("/v1/admin/features/example", () => ({ method: "PUT" }));
  assert.deepEqual([response.status, calls()], [403, 1]);
  assert.deepEqual(await response.json(), { error: "reauth", reason: "fresh_auth_required", message: "Confirm it's you." }, "the refusal is still readable");
});

test("other refusals are returned as they are, without asking", async () => {
  let asked = 0;
  setAdminReauthPrompt(async () => { asked += 1; return true; });
  globalThis.fetch = async () => Response.json({ error: "forbidden" }, { status: 403 });
  const response = await fetchAdminChange("/v1/admin/features/example", () => ({ method: "PUT" }));
  assert.deepEqual([response.status, asked], [403, 0]);
});
