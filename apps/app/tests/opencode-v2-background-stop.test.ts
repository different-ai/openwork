import { afterEach, expect, test } from "bun:test";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const base = "http://127.0.0.1:9/workspace/ws_1/opencode2";
const directory = "/workspace/report files";

function mockEngine(owner = "ses_1", deleteStatus = 204) {
  const requests: Request[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      if (request.method === "GET") return Response.json({ location: { directory }, data: {
        id: "sh_1", status: "running", command: "sleep 120", metadata: { sessionID: owner }, time: { started: 1000 },
      } });
      return deleteStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ name: "StopFailed" }, { status: deleteStatus });
    },
  });
  return requests;
}

test("V2 stop verifies the owner then deletes exactly that shell with the same auth and location", async () => {
  const requests = mockEngine();
  const result = await createClientV2(base, directory, { token: "fixture-token" }).removeBackgroundShell({ shellID: "sh_1", sessionID: "ses_1" });
  expect(result.error).toBeUndefined();
  expect(result.response.status).toBe(204);
  expect(requests.map((request) => request.method)).toEqual(["GET", "DELETE"]);
  for (const request of requests) {
    const url = new URL(request.url);
    expect(url.pathname).toBe("/workspace/ws_1/opencode2/api/shell/sh_1");
    expect(url.searchParams.get("location[directory]")).toBe(directory);
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token");
  }
});

test("another conversation's command cannot be deleted", async () => {
  const requests = mockEngine("ses_other");
  await expect(createClientV2(base, directory, {}).removeBackgroundShell({ shellID: "sh_1", sessionID: "ses_1" })).rejects.toThrow("does not belong");
  expect(requests.map((request) => request.method)).toEqual(["GET"]);
});

test("an unsuccessful DELETE returns an error rather than claiming the command stopped", async () => {
  mockEngine("ses_1", 500);
  const result = await createClientV2(base, directory, {}).removeBackgroundShell({ shellID: "sh_1", sessionID: "ses_1" });
  expect(result.error).toEqual({ name: "StopFailed" });
  expect(result.data).toBeUndefined();
});
