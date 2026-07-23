import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  errorMessage,
  getJson,
  parseResponse,
  postJson,
  requireOpenWorkServer,
  serverToken,
  serverUrl,
  type OpenWorkFetch,
} from "./server-client.js";

const missingServerMessage = "OpenWork extension tools are only available when OpenCode is launched by OpenWork.";
const originalServerUrl = process.env.OPENWORK_SERVER_URL;
const originalServerToken = process.env.OPENWORK_SERVER_TOKEN;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureServer(): void {
  process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787/";
  process.env.OPENWORK_SERVER_TOKEN = "secret-token";
}

describe("OpenWork server client", () => {
  beforeEach(() => {
    delete process.env.OPENWORK_SERVER_URL;
    delete process.env.OPENWORK_SERVER_TOKEN;
  });

  afterEach(() => {
    restoreEnv("OPENWORK_SERVER_URL", originalServerUrl);
    restoreEnv("OPENWORK_SERVER_TOKEN", originalServerToken);
  });

  test("reads the server URL and token using the existing normalization", () => {
    expect(serverUrl()).toBe("");
    expect(serverToken()).toBe("");

    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787//";
    process.env.OPENWORK_SERVER_TOKEN = "token";

    expect(serverUrl()).toBe("http://127.0.0.1:8787/");
    expect(serverToken()).toBe("token");
  });

  test("requires both OpenWork server environment variables", () => {
    expect(() => requireOpenWorkServer()).toThrow(missingServerMessage);

    process.env.OPENWORK_SERVER_URL = "http://127.0.0.1:8787";
    expect(() => requireOpenWorkServer()).toThrow(missingServerMessage);

    process.env.OPENWORK_SERVER_TOKEN = "token";
    expect(requireOpenWorkServer()).toEqual({
      url: "http://127.0.0.1:8787",
      token: "token",
    });
  });

  test("parses JSON, empty, and text responses", async () => {
    expect(await parseResponse(new Response('{"ok":true}'))).toEqual({ ok: true });
    expect(await parseResponse(new Response(""))).toBeNull();
    expect(await parseResponse(new Response("plain text"))).toEqual({ message: "plain text" });
  });

  test("selects message, code, then fallback for errors", () => {
    expect(errorMessage({ message: "specific", code: "ignored" }, "fallback")).toBe("specific");
    expect(errorMessage({ message: 42, code: "coded" }, "fallback")).toBe("coded");
    expect(errorMessage(null, "fallback")).toBe("fallback");
  });

  test("gets JSON with bearer authorization", async () => {
    configureServer();
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    const fetcher: OpenWorkFetch = async (url, init) => {
      receivedUrl = url;
      receivedInit = init;
      return new Response('{"items":["one"]}');
    };

    await expect(getJson("/workspaces", fetcher)).resolves.toEqual({ items: ["one"] });
    expect(receivedUrl).toBe("http://127.0.0.1:8787/workspaces");
    expect(receivedInit?.method).toBeUndefined();
    expect(new Headers(receivedInit?.headers).get("authorization")).toBe("Bearer secret-token");
  });

  test("preserves server and caller-provided GET failure messages", async () => {
    configureServer();

    await expect(getJson("/failure", async () => (
      new Response('{"message":"server said no"}', { status: 400 })
    ))).rejects.toThrow("server said no");

    await expect(getJson(
      "/failure",
      async () => new Response("", { status: 500 }),
      "OpenWork connect state request failed",
    )).rejects.toThrow("OpenWork connect state request failed");
  });

  test("posts JSON with the existing headers and fallback", async () => {
    configureServer();
    let receivedUrl = "";
    let receivedInit: RequestInit | undefined;
    const fetcher: OpenWorkFetch = async (url, init) => {
      receivedUrl = url;
      receivedInit = init;
      return new Response('{"ok":true}');
    };

    await expect(postJson("/experimental/extensions/call", { action: "demo" }, fetcher)).resolves.toEqual({ ok: true });
    expect(receivedUrl).toBe("http://127.0.0.1:8787/experimental/extensions/call");
    expect(receivedInit?.method).toBe("POST");
    expect(new Headers(receivedInit?.headers).get("authorization")).toBe("Bearer secret-token");
    expect(new Headers(receivedInit?.headers).get("content-type")).toBe("application/json");
    expect(receivedInit?.body).toBe('{"action":"demo"}');

    await expect(postJson(
      "/experimental/extensions/call",
      {},
      async () => new Response('{"code":"denied"}', { status: 403 }),
    )).rejects.toThrow("denied");
    await expect(postJson(
      "/experimental/extensions/call",
      {},
      async () => new Response("", { status: 500 }),
    )).rejects.toThrow("OpenWork extension call failed");
  });
});
