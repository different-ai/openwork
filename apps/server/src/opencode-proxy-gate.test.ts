import { describe, expect, test } from "bun:test";

import {
  assertOpencodeProxyAllowed,
  normalizeOpencodeDirectory,
  proxyOpencodeRequest,
  proxyOpencodeV2Request,
  scopeWorkspaceOpencodeRequest,
} from "./server.js";
import { ApiError } from "./errors.js";
import type { Actor, ServerConfig, TokenScope, WorkspaceInfo } from "./types.js";

const actor = (scope: TokenScope | undefined): Actor => ({ type: "remote", scope });

const PERMISSION_REPLY_PATH = "/opencode/permission/req_123/reply";

describe("assertOpencodeProxyAllowed", () => {
  test("collaborators can reply to permission requests (#1918)", () => {
    // The SPA's only credential is the collaborator-scoped client token
    // (OPENWORK_TOKEN); an owner-only gate made every permission dialog
    // un-answerable.
    expect(() =>
      assertOpencodeProxyAllowed(actor("collaborator"), "POST", PERMISSION_REPLY_PATH),
    ).not.toThrow();
  });

  test("owners can reply to permission requests", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor("owner"), "POST", PERMISSION_REPLY_PATH),
    ).not.toThrow();
  });

  test("viewers cannot send any mutating request", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor("viewer"), "POST", PERMISSION_REPLY_PATH),
    ).toThrow(ApiError);
    expect(() =>
      assertOpencodeProxyAllowed(actor("viewer"), "POST", "/opencode/session/s1/command"),
    ).toThrow(ApiError);
  });

  test("viewers can still read", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor("viewer"), "GET", "/opencode/permission"),
    ).not.toThrow();
  });

  test("missing scope defaults to viewer (read-only)", () => {
    expect(() =>
      assertOpencodeProxyAllowed(actor(undefined), "POST", PERMISSION_REPLY_PATH),
    ).toThrow(ApiError);
    expect(() =>
      assertOpencodeProxyAllowed(actor(undefined), "GET", "/opencode/permission"),
    ).not.toThrow();
  });
});

describe("scopeWorkspaceOpencodeRequest", () => {
  test("overwrites caller-controlled directory headers and query parameters", () => {
    const scoped = scopeWorkspaceOpencodeRequest(
      new Headers({ "x-opencode-directory": "/tmp/foreign" }),
      "?directory=%2Ftmp%2Fforeign&roots=true&directory=%2Ftmp%2Fother",
      "/tmp/workspace",
    );

    expect(scoped.headers.get("x-opencode-directory")).toBe("/tmp/workspace");
    expect(new URLSearchParams(scoped.search).getAll("directory")).toEqual(["/tmp/workspace"]);
    expect(new URLSearchParams(scoped.search).get("roots")).toBe("true");
  });

  test("removes caller-controlled directory scope when a workspace has no engine directory", () => {
    const scoped = scopeWorkspaceOpencodeRequest(
      new Headers({ "X-OpenCode-Directory": "/tmp/foreign" }),
      "?directory=%2Ftmp%2Fforeign&limit=10",
      null,
    );

    expect(scoped.headers.has("x-opencode-directory")).toBe(false);
    expect(new URLSearchParams(scoped.search).has("directory")).toBe(false);
    expect(new URLSearchParams(scoped.search).get("limit")).toBe("10");
  });

  test("encodes non-ASCII directory headers while preserving the query value", () => {
    const directory = "/tmp/项目";
    const scoped = scopeWorkspaceOpencodeRequest(new Headers(), "", directory);

    expect(scoped.headers.get("x-opencode-directory")).toBe(encodeURIComponent(directory));
    expect(new URLSearchParams(scoped.search).get("directory")).toBe(directory);
  });
});

describe("normalizeOpencodeDirectory", () => {
  test("removes Windows extended-length prefixes", () => {
    expect(normalizeOpencodeDirectory("\\\\?\\C:\\Users\\agent\\repo", "win32"))
      .toBe("C:\\Users\\agent\\repo");
    expect(normalizeOpencodeDirectory("//?/C:/Users/agent/repo", "win32"))
      .toBe("C:/Users/agent/repo");
  });

  test("leaves paths unchanged on non-Windows platforms", () => {
    expect(normalizeOpencodeDirectory("\\\\?\\C:\\Users\\agent\\repo", "darwin"))
      .toBe("\\\\?\\C:\\Users\\agent\\repo");
  });
});

describe("proxyOpencodeRequest read-only guard", () => {
  const workspace: WorkspaceInfo = {
    id: "ws_ro",
    name: "Read-only workspace",
    path: "/tmp/openwork-proxy-gate-ro",
    preset: "starter",
    workspaceType: "local",
  };

  const readOnlyConfig: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [workspace],
    authorizedRoots: [workspace.path],
    readOnly: true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };

  const proxy = (method: string) => {
    const proxyPath = "/session";
    const url = new URL(`http://openwork.invalid/opencode${proxyPath}`);
    return proxyOpencodeRequest({
      config: readOnlyConfig,
      workspace,
      proxyPath,
      url,
      request: new Request(url, { method }),
    });
  };

  test("native Cloud catalog reads expose metadata, not private bodies or paths, to shared clients", async () => {
    const cloud = {
      id: "openwork-cloud-0123456789abcdef", name: "briefing", description: "Prepare a briefing", slash: true,
      content: "OWNER_PRIVATE_INSTRUCTIONS", location: "/private/cloud-skills/scope/SKILL.md",
      futurePrivateField: "OWNER_PRIVATE_INSTRUCTIONS",
    };
    const local = { id: "local-briefing", name: "local", content: "Workspace instructions", location: "/workspace/.opencode/skills/local/SKILL.md" };
    const engine = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        const path = decodeURIComponent(new URL(request.url).pathname);
        return Response.json({ data: path.includes(cloud.id) ? cloud : [local, cloud] });
      },
    });
    try {
      for (const scope of ["viewer", "collaborator", undefined, "owner"] as const) {
        for (const suffix of ["/api/skill", "/api/skill/", "/api/%73kill", `/api/skill/${cloud.id}`]) {
          const proxyPath = `/opencode2${suffix}`;
          const url = new URL(`http://openwork.invalid/workspace/ws_ro${proxyPath}`);
          const response = await proxyOpencodeV2Request({
            actor: actor(scope), config: readOnlyConfig, workspace, proxyPath, url,
            request: new Request(url),
            connection: { url: `http://127.0.0.1:${engine.port}`, username: "opencode", password: "fixture-only" },
            syncCloudSkills: async () => { throw new Error("Catalog reads must not sync or alter Cloud skills"); },
          });
          expect(response.status).toBe(200);
          const payload = await response.json();
          const entry = Array.isArray(payload.data) ? payload.data[1] : payload.data;
          expect(entry).toEqual(scope === "owner" ? cloud : {
            id: cloud.id, name: cloud.name, description: cloud.description, slash: true,
          });
          if (Array.isArray(payload.data)) expect(payload.data[0]).toEqual(local);
          if (scope !== "owner") {
            expect(JSON.stringify(payload)).not.toContain("OWNER_PRIVATE_INSTRUCTIONS");
            expect(JSON.stringify(payload)).not.toContain("/private/cloud-skills");
          }
        }
      }
    } finally {
      await engine.stop(true);
    }
  });

  test("rejects native proxy writes on a read-only server (parity with the removed ensureWritable wrapper routes)", async () => {
    for (const method of ["POST", "DELETE", "PATCH", "PUT"]) {
      const error = await proxy(method).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect(error instanceof ApiError ? error.code : null).toBe("read_only");
    }
  });

  test("still lets reads through the read-only gate", async () => {
    // No engine is configured, so a read that passes the read-only gate fails
    // later with opencode_unconfigured — proving the gate did not block it.
    const error = await proxy("GET").then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error instanceof ApiError ? error.code : null).toBe("opencode_unconfigured");
  });
});
