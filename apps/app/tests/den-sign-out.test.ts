import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient, DenApiError } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

function setFetch(fetchImpl: typeof fetch) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchImpl,
  });
}

afterEach(() => {
  setFetch(originalFetch);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("Den sign-out", () => {
  test("resolves only after the server confirms sign-out", async () => {
    const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
    setFetch(async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
      });
      return new Response(null, { status: 204 });
    });

    await expect(
      createDenClient({ baseUrl: "https://den.test", token: "tok_test" }).signOut(),
    ).resolves.toBeUndefined();
    expect(requests).toEqual([
      {
        url: "https://den.test/api/auth/sign-out",
        method: "POST",
        authorization: "Bearer tok_test",
      },
    ]);
  });

  test("routes desktop sign-out to the direct API base", async () => {
    const requests: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __OPENWORK_ELECTRON__: {
          invokeDesktop: async (command: string, url: string) => {
            expect(command).toBe("__fetch");
            requests.push(url);
            return { status: 204, statusText: "No Content", headers: {}, body: "" };
          },
        },
      },
    });

    await createDenClient({
      baseUrl: "https://app.den.test",
      apiBaseUrl: "https://api.den.test",
      token: "tok_test",
    }).signOut();

    expect(requests).toEqual(["https://api.den.test/api/auth/sign-out"]);
  });

  test("routes hosted desktop sign-out to the nested hosted API default", async () => {
    const requests: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __OPENWORK_ELECTRON__: {
          invokeDesktop: async (command: string, url: string) => {
            expect(command).toBe("__fetch");
            requests.push(url);
            return { status: 204, statusText: "No Content", headers: {}, body: "" };
          },
        },
      },
    });

    await createDenClient({
      baseUrl: "https://app.openworklabs.com",
      token: "tok_test",
    }).signOut();

    expect(requests).toEqual(["https://api.app.openworklabs.com/api/auth/sign-out"]);
  });

  test("keeps legacy desktop proxy API bases working for sign-out", async () => {
    const requests: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __OPENWORK_ELECTRON__: {
          invokeDesktop: async (command: string, url: string) => {
            expect(command).toBe("__fetch");
            requests.push(url);
            return { status: 204, statusText: "No Content", headers: {}, body: "" };
          },
        },
      },
    });

    await createDenClient({
      baseUrl: "https://app.den.test",
      apiBaseUrl: "https://app.den.test/api/den",
      token: "tok_test",
    }).signOut();

    expect(requests).toEqual(["https://app.den.test/api/den/api/auth/sign-out"]);
  });

  test("rejects a non-success response so local credentials can be retained", async () => {
    setFetch(async () =>
      new Response(JSON.stringify({ error: "sign_out_failed", message: "Try again." }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = createDenClient({ baseUrl: "https://den.test", token: "tok_test" }).signOut();
    await expect(result).rejects.toBeInstanceOf(DenApiError);
    await expect(result).rejects.toMatchObject({ status: 503, code: "sign_out_failed" });
  });

  test("rejects a network failure so the user can retry", async () => {
    setFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(
      createDenClient({ baseUrl: "https://den.test", token: "tok_test" }).signOut(),
    ).rejects.toThrow("Failed to fetch");
  });

  test("rejects direct desktop signup without calling the auth endpoint", async () => {
    const requests: string[] = [];
    setFetch(async (input) => {
      requests.push(String(input));
      return new Response(null, { status: 204 });
    });

    const result = createDenClient({ baseUrl: "https://den.test" }).signUpEmail("user@example.test", "aaaaaaaa");
    await expect(result).rejects.toMatchObject({
      status: 410,
      code: "desktop_signup_deprecated",
      message: "Create your account in the browser to choose a secure password.",
    });
    expect(requests).toEqual([]);
  });
});
