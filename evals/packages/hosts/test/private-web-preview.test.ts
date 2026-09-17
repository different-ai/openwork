import assert from "node:assert/strict";
import test from "node:test";
import { parsePrivatePreview, privateSandboxId, privateWebPreview, verifyPrivateWebPreview } from "../src/private-web-preview.ts";

const preview = { browserOrigin: "https://5178-signed.example.test", unsignedOrigin: "https://5178-sandbox-id.example.test", browserHostSuffix: ".example.test" };
const info = { code: 0, stdout: JSON.stringify({ id: "sandbox-id", public: false, toolboxProxyUrl: "https://example.test/toolbox" }), stderr: "" };

test("private preview requires a hostname-bound credential and never accepts public or query-token URLs", () => {
  assert.deepEqual(parsePrivatePreview(preview.browserOrigin, "sandbox-id", 5178), preview);
  for (const value of [preview.unsignedOrigin, `${preview.browserOrigin}?token=secret`, "http://localhost:5178", "https://5179-secret.example.test", "https://5178-.example.test", "not a URL"]) {
    assert.throws(() => parsePrivatePreview(value, "sandbox-id", 5178));
  }
  assert.throws(() => parsePrivatePreview("https://5178-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.example.test", "sandbox-id", 5178));
});

test("private identity and signed-preview issuance fail closed without logging provider output", async () => {
  assert.equal(await privateSandboxId("owned", async () => ({ code: 0, stdout: '{"id":"sandbox-id","public":false}', stderr: "" })), "sandbox-id");
  for (const stdout of ['{"id":"sandbox-id","public":true}', '{"id":"sandbox-id"}', "secret invalid JSON"]) {
    await assert.rejects(privateSandboxId("owned", async () => ({ code: 0, stdout, stderr: "" })), (error: unknown) => error instanceof Error && !error.message.includes("secret"));
  }
  const result = await privateWebPreview("sandbox-id", 5178, async (args) => {
    if (args[0] === "info") { assert.deepEqual(args, ["info", "sandbox-id", "-f", "json"]); return info; }
    assert.deepEqual(args, ["preview-url", "sandbox-id", "-p", "5178", "--expires", "3600"]);
    return { code: 0, stdout: preview.browserOrigin, stderr: "" };
  });
  assert.deepEqual(result, preview);
  await privateWebPreview("sandbox-id", 5178, async (args) => {
    if (args[0] === "info") return info;
    assert.equal(args.at(-1), "7200");
    return { code: 0, stdout: preview.browserOrigin, stderr: "" };
  }, 7200);
  for (const expiry of [0, 86401, 1.5]) {
    await assert.rejects(privateWebPreview("sandbox-id", 5178, async () => { throw new Error("must not execute"); }, expiry), /expiry/);
  }
});

test("signed issuance follows structured private identity and rejects mismatched domain receipts", async () => {
  for (const identity of [{ id: "other", public: false, toolboxProxyUrl: "https://example.test/toolbox" },
    { id: "sandbox-id", public: true }, { id: "sandbox-id", public: false },
    { id: "sandbox-id", public: false, toolboxProxyUrl: "https://2280-other.example.test" }]) {
    const calls: string[] = [];
    await assert.rejects(privateWebPreview("sandbox-id", 5178, async (args) => {
      calls.push(args[0] ?? ""); return { code: 0, stdout: JSON.stringify(identity), stderr: "" };
    }));
    assert.deepEqual(calls, ["info"]);
  }
});

function requestFake(exposed = false, brokenAsset = false): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.origin === preview.unsignedOrigin) return new Response("", { status: exposed ? 200 : 401 });
    if (url.pathname === "/") return new Response('<script src="/@vite/client"></script>');
    if (url.pathname === "/@vite/client") return new Response('const wsToken = "vite-token";', { status: brokenAsset ? 404 : 200 });
    return new Response('{}', { headers: { "content-type": "application/json" } });
  };
}

test("preview verification checks external HTTP, assets, WebSockets and same-origin backend", async () => {
  const sockets: string[] = [];
  await verifyPrivateWebPreview(preview, requestFake(), async (url) => {
    sockets.push(url);
    return url.includes("5178-signed.");
  });
  assert.equal(sockets.length, 2);
  assert(sockets.every((url) => url.startsWith("wss:") && url.endsWith("?token=vite-token")));
});

test("preview verification refuses public assets or unsupported signed WebSockets and redacts bearer URLs", async () => {
  for (const [request, opens] of [
    { request: requestFake(true), opens: async () => false },
    { request: requestFake(false, true), opens: async () => false },
    { request: requestFake(), opens: async () => true },
    { request: requestFake(), opens: async () => false },
  ].map(({ request, opens }) => [request, opens] satisfies [typeof fetch, (url: string) => Promise<boolean>])) {
    await assert.rejects(verifyPrivateWebPreview(preview, request, opens), (error: unknown) => error instanceof Error
      && error.message.includes("Security prerequisite") && !error.message.includes("5178-signed"));
  }
});
