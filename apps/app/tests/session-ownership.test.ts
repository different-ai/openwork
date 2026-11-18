import { afterEach, describe, expect, test } from "bun:test";

import { createClient } from "../src/app/lib/opencode";
import { interruptSessionTurn } from "../src/app/lib/opencode-interruption";
import { readSessionTree } from "../src/app/lib/session-ownership";

// The desktop keeps the workspace path as it was added; the engine serves and
// stamps sessions with its realpath (opencode FSUtil.resolve -> realpathSync).
// This is the layout a fresh macOS dev profile lands in: `/var` -> `/private/var`.
const WORKSPACE = "/var/folders/synthetic/OpenWork Chat";
const ELSEWHERE = "/var/folders/synthetic/Elsewhere";
const real = (path: string) => path.replace(/^\/var(?=\/|$)/, "/private/var");
const baseUrl = "http://engine.invalid/workspace/ws-linked/opencode";

type Session = { id: string; parentID?: string; directory: string; title: string };
const sessions: Session[] = [
  { id: "ses_root", directory: real(WORKSPACE), title: "Split pane conversation" },
  { id: "ses_child", parentID: "ses_root", directory: real(WORKSPACE), title: "Subtask" },
  { id: "ses_sibling", directory: real(WORKSPACE), title: "Other pane" },
  { id: "ses_foreign", directory: real(ELSEWHERE), title: "Another workspace" },
  { id: "ses_stray", directory: real(WORKSPACE), title: "Stray parent" },
  { id: "ses_stray_child", parentID: "ses_stray", directory: real(ELSEWHERE), title: "Foreign subtask" },
];

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** A fake engine that answers /path with the real directory, the way OpenCode does after realpath. */
function serveEngine() {
  const requests: { method: string; path: string; directory: string | null }[] = [];
  const info = (session: Session) => ({ ...session, projectID: "global", version: "synthetic", time: { created: 1, updated: 1 } });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/workspace\/ws-linked\/opencode/, "");
      const directory = url.searchParams.get("directory");
      requests.push({ method: request.method, path, directory });
      const match = /^\/session\/([^/]+)(?:\/(children|message|abort))?$/.exec(path);
      const session = match ? sessions.find((item) => item.id === match[1]) : undefined;
      if (path === "/path" && request.method === "GET" && directory) {
        return Response.json({ home: "/synthetic", state: "/synthetic/state", config: "/synthetic/config", worktree: real(directory), directory: real(directory) });
      }
      if (path === "/session/status" && request.method === "GET") return Response.json({});
      if (session && match && match[2] === undefined && request.method === "GET") return Response.json(info(session));
      if (session && match && match[2] === "children" && request.method === "GET") return Response.json(sessions.filter((item) => item.parentID === session.id).map(info));
      if (session && match && match[2] === "message" && request.method === "GET") return Response.json([]);
      if (session && match && match[2] === "abort" && request.method === "POST") return Response.json(true);
      return Response.json({ name: "NotFoundError", data: { message: `Unknown ${request.method} ${path}` } }, { status: 404 });
    },
  });
  return requests;
}

describe("session ownership across a linked workspace path", () => {
  test("archive reads the tree by the engine's resolved directory and still refuses other workspaces", async () => {
    const requests = serveEngine();
    const client = createClient(baseUrl, WORKSPACE, { token: "synthetic", mode: "openwork" });
    expect(await readSessionTree(client, "ses_root", WORKSPACE)).toEqual(["ses_root", "ses_child"]);
    expect(await readSessionTree(client, "ses_sibling", WORKSPACE)).toEqual(["ses_sibling"]);
    const resolved = requests.filter((request) => request.path === "/path");
    expect(resolved.length).toBeGreaterThanOrEqual(2);
    expect(resolved.every((request) => request.method === "GET" && request.directory === WORKSPACE)).toBe(true);
    await expect(readSessionTree(client, "ses_foreign", WORKSPACE)).rejects.toThrow("Could not verify the conversation's workspace.");
    await expect(readSessionTree(client, "ses_stray", WORKSPACE)).rejects.toThrow("Could not verify a subtask's owner.");
    const elsewhere = createClient(baseUrl, ELSEWHERE, { token: "synthetic", mode: "openwork" });
    await expect(readSessionTree(elsewhere, "ses_root", ELSEWHERE)).rejects.toThrow("Could not verify the conversation's workspace.");
    expect(await readSessionTree(elsewhere, "ses_foreign", ELSEWHERE)).toEqual(["ses_foreign"]);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  test("Stop settles the root in a linked workspace and still refuses a session from another workspace", async () => {
    const requests = serveEngine();
    const client = createClient(baseUrl, WORKSPACE, { token: "synthetic", mode: "openwork" });
    await interruptSessionTurn(baseUrl, client, "ses_root", WORKSPACE, { timeoutMs: 10_000 });
    expect(requests.filter((request) => request.method === "POST").map((request) => request.path)).toEqual(["/session/ses_root/abort", "/session/ses_root/abort"]);
    expect(requests.some((request) => request.path === "/path" && request.directory === WORKSPACE)).toBe(true);
    const before = requests.length;
    await expect(interruptSessionTurn(baseUrl, client, "ses_foreign", WORKSPACE, { timeoutMs: 10_000 }))
      .rejects.toThrow("Could not verify the conversation's workspace. Stop was not confirmed.");
    // The native abort still reaches the engine first; only the settlement claim is withheld and no cascade follows.
    expect(requests.slice(before).filter((request) => request.method === "POST").map((request) => request.path)).toEqual(["/session/ses_foreign/abort"]);
  });
});
