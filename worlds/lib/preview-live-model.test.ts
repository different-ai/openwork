import assert from "node:assert/strict";
import test from "node:test";
import { defaultPreviewModelId, installLiveModel } from "./preview-live-model.ts";
import { parseAppWebOptions } from "./app-web-options.ts";

const ref = "a".repeat(40);
for (const place of ["daytona", "freestyle"]) {
  test(`live model is opt-in for the ${place} web preview`, () => {
    const env = { OPENWORK_WORLD_PLACE: place };
    assert.equal(parseAppWebOptions(["--ref", ref], env, true).liveModelTeam, undefined);
    assert.equal(parseAppWebOptions(["--live-model", "team_example", "--ref", ref], env, true).liveModelTeam, "team_example");
    assert.throws(() => parseAppWebOptions(["--live-model", "team_example", "--ref", ref], env));
    assert.equal(parseAppWebOptions(["--ref", ref, "--model", "example/model", "--live-model", "team_dev"], env, true).modelId, "example/model");
    assert.throws(() => parseAppWebOptions(["--ref", ref, "--model", "example/model"], env, true));
    assert.throws(() => parseAppWebOptions(["--live-model", "default", "--ref", ref], env, true));
  });
}

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
        return JSON.stringify({ apiKey: { id: "exampleOpaqueId" }, apiKeyString: "test-preview-token" });
      }
      return "";
    };
    const setup = async () => {
      await using stack = new AsyncDisposableStack();
      const startRelay = async (key: string, model: string) => {
        assert.equal(key, "test-preview-token");
        assert.equal(model, defaultPreviewModelId);
        calls.push("relay");
        return 1234;
      };
      const result = await installLiveModel(stack, { startRelay, team: "team_dev", expiresAt, origin: "https://example.test",
        headers: {}, token: "client", hostToken: "owner" }, api, async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/workspaces")) return Response.json({ items: [{ id: "ws" }] });
        assert.equal(init?.redirect, "error");
        assert.ok(!String(init?.body).includes("test-preview-token"));
        if (path.endsWith("/providers")) {
          assert.equal(new Headers(init?.headers).get("x-openwork-host-token"), "owner");
          assert.equal(JSON.parse(String(init?.body)).provider["preview-live"].options.baseURL, "http://127.0.0.1:1234/v1");
          return new Response(null, { status: failSetup ? 500 : 204 });
        }
        assert.equal(path, "/api/openwork/workspace/ws/default-model");
        assert.deepEqual(JSON.parse(String(init?.body)).model, { providerID: "preview-live", modelID: defaultPreviewModelId });
        return Response.json({ ok: true });
      });
      assert.ok(!JSON.stringify(result).includes("test-preview-token"));
    };
    if (failSetup) await assert.rejects(setup, /HTTP 500/);
    else await setup();
    assert.deepEqual(calls, ["POST", "relay", "DELETE"]);
  });
}

test("malformed key responses never reach the launcher error output", async () => {
  await using stack = new AsyncDisposableStack();
  const install = installLiveModel(stack, {
    startRelay: async () => assert.fail("unexpected relay"), team: "team_dev", expiresAt: new Date(Date.now() + 60_000).toISOString(), origin: "https://example.test",
    headers: {}, token: "client", hostToken: "owner",
  }, async () => "secret-fixture is not JSON", async () => Response.json({ items: [{ id: "ws" }] }));
  await assert.rejects(install, { message: "Vercel returned an invalid preview key response." });
});

test("a failed private file upload cannot print its body or pass the key as a command", async () => {
  const { startModelRelay } = await import("./preview-model-guest.ts");
  let attempted = false;
  const key = "synthetic-upload-secret";
  await assert.rejects(startModelRelay({
    async run(command) { assert.ok(!command.includes(key)); return ""; },
    async write(path, content) {
      if (path.endsWith("/credential")) {
        attempted = true;
        assert.deepEqual(JSON.parse(content), { key, model: defaultPreviewModelId });
        throw new Error(content);
      }
    },
  }, key, defaultPreviewModelId), { message: "Could not start the private preview model relay." });
  assert.equal(attempted, true);
});
