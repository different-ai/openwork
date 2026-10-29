import { afterEach, describe, expect, test } from "bun:test";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";

const base = "http://127.0.0.1:9/workspace/ws_1/opencode2";
const originalFetch = globalThis.fetch;

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return handler(request);
    },
  });
  return requests;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenCode v2 session lifecycle", () => {
  test("a turn's idle marker never shows as a message", async () => {
    serve(() => Response.json({
      data: [
        { id: "msg_user", sessionID: "ses_1", type: "user", text: "Hi", time: { created: 1 } },
        { id: "msg_reply", sessionID: "ses_1", type: "assistant", content: [{ type: "text", text: "Hello" }], time: { created: 2, completed: 3 } },
        { id: "msg_idle", sessionID: "ses_1", type: "idle", outcome: "succeeded", time: { created: 4 } },
      ],
    }));
    const client = createClientV2(base, "/tmp/ws", { token: "t" });

    const result = await client.session.messages({ sessionID: "ses_1" });

    expect(result.data?.map((message) => message.info.id)).toEqual(["msg_user", "msg_reply"]);
  });
});
