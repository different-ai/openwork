import assert from "node:assert/strict";
import test from "node:test";
import { parseAppWebOptions } from "./app-web-options.ts";

const ref = "a".repeat(40);
for (const place of ["daytona", "freestyle"]) {
  test(`live model is opt-in for the ${place} web preview`, () => {
    const env = { OPENWORK_WORLD_PLACE: place };
    assert.equal(parseAppWebOptions(["--ref", ref], env, true).liveModelTeam, undefined);
    assert.equal(parseAppWebOptions(["--live-model", "team_example", "--ref", ref], env, true).liveModelTeam, "team_example");
    assert.throws(() => parseAppWebOptions(["--live-model", "team_example", "--ref", ref], env));
    assert.throws(() => parseAppWebOptions(["--live-model", "default", "--ref", ref], env, true));
  });
}

import { installLiveModel, previewModel } from "./preview-live-model.ts";

for (const failSetup of [true, false]) {
  test(`preview key is bounded and revoked after ${failSetup ? "a failed setup" : "use"}`, async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const calls: string[] = [];
    const api = async (args: string[], body?: object) => {
      calls.push(args[2]);
      assert.ok(args[0].endsWith("?teamId=team_dev"));
      if (body) {
        assert.deepEqual(body, { name: (body as { name: string }).name, purpose: "ai-gateway",
          expiresAt: Date.parse(expiresAt), aiGatewayQuota: { limitAmount: 1, includeByokInQuota: true } });
        return JSON.stringify({ apiKey: { id: "key_123" }, apiKeyString: "test-preview-token" });
      }
      return "";
    };
    const setup = async () => {
      await using stack = new AsyncDisposableStack();
      const result = await installLiveModel(stack, { team: "team_dev", expiresAt, origin: "https://example.test",
        headers: {}, token: "client", hostToken: "owner" }, api, async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/workspaces")) return Response.json({ items: [{ id: "ws" }] });
        if (path.endsWith("/providers")) {
          assert.equal(new Headers(init?.headers).get("x-openwork-host-token"), "owner");
          assert.ok(String(init?.body).includes("test-preview-token"));
          return new Response(null, { status: failSetup ? 500 : 204 });
        }
        assert.equal(path, "/api/openwork/workspace/ws/default-model");
        assert.deepEqual(JSON.parse(String(init?.body)).model, previewModel);
        return Response.json({ ok: true });
      });
      assert.ok(!JSON.stringify(result).includes("test-preview-token"));
    };
    if (failSetup) await assert.rejects(setup, /HTTP 500/);
    else await setup();
    assert.deepEqual(calls, ["POST", "DELETE"]);
  });
}
