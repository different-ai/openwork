import { describe, expect, test } from "bun:test";
import { transferResponseBody } from "./server-fetch.js";

describe("transferResponseBody", () => {
  test("locks the source stream before the original Response can be collected", async () => {
    const original = new Response("streamed response");
    const source = original.body;

    const transferred = transferResponseBody(original);

    expect(source).not.toBeNull();
    expect(source?.locked).toBe(true);
    expect(transferred).not.toBeNull();
    await expect(new Response(transferred).text()).resolves.toBe("streamed response");
  });

  test("supports repeated response wrapping without disturbing the body", async () => {
    const original = new Response("wrapped twice", {
      status: 202,
      statusText: "Accepted",
      headers: { "x-test": "preserved" },
    });
    const first = new Response(transferResponseBody(original), {
      status: original.status,
      statusText: original.statusText,
      headers: original.headers,
    });
    const second = new Response(transferResponseBody(first), {
      status: first.status,
      statusText: first.statusText,
      headers: first.headers,
    });

    expect(original.body?.locked).toBe(true);
    expect(first.body?.locked).toBe(true);
    expect(second.status).toBe(202);
    expect(second.statusText).toBe("Accepted");
    expect(second.headers.get("x-test")).toBe("preserved");
    await expect(second.text()).resolves.toBe("wrapped twice");
  });

  test("preserves responses without bodies", () => {
    expect(transferResponseBody(new Response(null, { status: 204 }))).toBeNull();
  });
});
