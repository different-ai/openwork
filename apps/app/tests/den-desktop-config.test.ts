import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;

describe("Den desktop config client", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  });

  test("pins desktop config requests to the active organization", async () => {
    const headers: Headers[] = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ connectEnabled: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    await createDenClient({ baseUrl: "https://den.test", token: "tok_test" }).getDesktopConfig("org_test");

    expect(headers[0]?.get("x-openwork-legacy-org-id")).toBe("org_test");
  });
});
