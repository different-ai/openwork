import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OpenworkSessionHistory } from "../src/app/lib/openwork-server";
import { useOpeningSessionHistory } from "../src/react-app/domains/session/surface/session-history";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { composeNativeSessionHistory } from "../src/app/lib/opencode-session-native";
import { createClient } from "../src/app/lib/opencode";
import { interruptSessionTurn } from "../src/app/lib/opencode-interruption";
import { buildOpenworkSessionSystemContext, clearOpenworkEnvSystemContextCache } from "../src/react-app/domains/session/sync/env-context";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  clearOpenworkEnvSystemContextCache();
});

function fixture() {
  const main: Request[] = [];
  const renderer: Request[] = [];
  const directory = "/fixture/send";
  const session = (id: string) => ({ id, directory, parentID: id === "ses_child" ? "ses_root" : undefined, time: { created: 1, updated: 1 } });
  const messages = (id: string) => id === "ses_root" ? [
    { info: { id: "msg_user", sessionID: id, role: "user", time: { created: 1 } }, parts: [] },
    { info: { id: "msg_assistant", sessionID: id, parentID: "msg_user", role: "assistant", time: { created: 2 } }, parts: [{
      id: "prt_task", sessionID: id, messageID: "msg_assistant", type: "tool", tool: "task", callID: "call_child",
      state: { status: "running", input: { subagent_type: "explore" }, metadata: { sessionId: "ses_child" }, time: { start: 2 } },
    }] },
  ] : [];
  const respond = (request: Request) => {
    const path = new URL(request.url).pathname.replace("/workspace/ws_fixture/opencode", "");
    if (path === "/env/keys") return { keys: ["FIXTURE_KEY"] };
    if (path === "/path") return { directory, worktree: directory, home: directory, state: directory, config: directory };
    if (path === "/permission" || path === "/question") return [];
    if (path === "/session/status") return {};
    if (path.endsWith("/abort")) return true;
    const match = path.match(/^\/session\/(ses_root|ses_child)(\/message)?$/);
    if (!match) throw new Error(`Unexpected fixture request ${path}`);
    return match[2] ? messages(match[1]) : session(match[1]);
  };
  const raw: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    renderer.push(request);
    return Response.json(respond(request));
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: raw });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { fetch: raw, __OPENWORK_ELECTRON__: {
    invokeDesktop: async (command: string, url: string, init: RequestInit) => {
      expect(command).toBe("__fetch");
      const request = new Request(url, init);
      main.push(request);
      return { status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: JSON.stringify(respond(request)) };
    },
  } } });
  return { main, renderer, directory, base: "http://127.0.0.1:8788/workspace/ws_fixture/opencode" };
}

test("only the uncached send-history preflight requests isolated transport; cached sends and background refresh keep their contracts", async () => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  try {
    for (const warm of [false, true]) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const host = document.createElement("div");
      const root = createRoot(host);
      const calls: ({ desktopTransport: "main" } | undefined)[] = [];
      const history: OpenworkSessionHistory = { session: { id: "ses_history", title: "History", version: "1", time: { created: 1, updated: 1 } }, messages: [] };
      const key = ["send-history-isolation", String(warm)];
      if (warm) client.setQueryData(key, history);
      let readSend: (() => Promise<OpenworkSessionHistory["messages"]>) | undefined;
      function Harness() {
        const opening = useOpeningSessionHistory({ owner: String(warm), sessionId: "ses_history", snapshotQueryKey: key,
          readSnapshot: async () => history,
          readLatest: async (_signal, options) => { calls.push(options); return history; },
        });
        readSend = opening.readSendHistory;
        return null;
      }
      try {
        await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Harness))));
        if (!readSend) throw new Error("Send-history callback was not mounted");
        expect(await readSend()).toEqual([]);
        expect(calls).toEqual(warm ? [undefined] : [{ desktopTransport: "main" }]);
        await act(async () => client.setQueryData(key, history));
        expect(await readSend()).toEqual([]);
        expect(calls).toHaveLength(1);
      } finally {
        await act(async () => root.unmount());
        client.clear();
      }
    }
  } finally {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    await GlobalRegistrator.unregister();
  }
});

test("ordinary-send environment preflight opts in without changing other environment reads or disclosing values", async () => {
  const world = fixture();
  const client = createOpenworkServerClient({ baseUrl: "http://127.0.0.1:8788", token: "fixture-client", hostToken: "fixture-host" });
  const context = await buildOpenworkSessionSystemContext(client, { cacheKey: "ses_root", readPendingChanges: () => false, desktopTransport: "main" });
  expect(context).toContain("FIXTURE_KEY");
  expect(context).not.toContain("fixture-host");
  expect(world.renderer).toHaveLength(0);
  expect(world.main).toHaveLength(1);
  expect(world.main[0].headers.get("authorization")).toBe("Bearer fixture-client");
  expect(world.main[0].headers.get("x-openwork-host-token")).toBe("fixture-host");
  await client.listUserEnvKeys();
  expect(world.renderer).toHaveLength(1);
  expect(world.main).toHaveLength(1);
});

test("Stop verification uses its scoped client for foreground descendants, ownership, idle and approvals", async () => {
  const world = fixture();
  const client = createClient(world.base, world.directory, { token: "fixture-client", mode: "openwork" }, { desktopTransport: "main" });
  await interruptSessionTurn(world.base, client, "ses_root", world.directory, { timeoutMs: 2_000 });
  expect(world.renderer).toHaveLength(0);
  const paths = world.main.map(request => new URL(request.url).pathname.replace("/workspace/ws_fixture/opencode", ""));
  for (const path of ["/session/ses_root/abort", "/session/ses_child/abort", "/session/ses_child", "/session/ses_child/message", "/path", "/session/status", "/permission", "/question"]) expect(paths).toContain(path);
  expect(paths.some(path => path.includes("prompt"))).toBe(false);
  expect(world.main.every(request => request.headers.get("authorization") === "Bearer fixture-client" && new URL(request.url).searchParams.get("directory") === world.directory)).toBe(true);
});

test("Stop's final history refresh opts in without changing ordinary snapshot transport", async () => {
  const world = fixture();
  const endpoint = { opencodeBaseUrl: world.base, token: "fixture-client" };
  const snapshot = await composeNativeSessionHistory({ ...endpoint, desktopTransport: "main" }, "ses_root");
  expect(snapshot.session.id).toBe("ses_root");
  expect(snapshot.messages).toHaveLength(2);
  expect(world.renderer).toHaveLength(0);
  expect(world.main).toHaveLength(2);
  await composeNativeSessionHistory(endpoint, "ses_root");
  expect(world.renderer).toHaveLength(2);
  expect(world.main).toHaveLength(2);
});
