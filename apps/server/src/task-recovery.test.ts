import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTaskRecovery, RECOVERY_INTERVAL_MS } from "./task-recovery.js";
import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore } from "./workspace-kv-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setSystemTime();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(engine: "v1" | "v2") {
  const root = await mkdtemp(join(tmpdir(), "task-recovery-"));
  const previousDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const workspace = { id: "ws", name: "Work", path: root, preset: "starter", workspaceType: "local" as const };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 1234, token: "test-token", hostToken: "test-host", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [root],
    readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  type Task = { active: boolean; blocked: boolean; completed: boolean; aborted: boolean; user: number; delegated?: boolean };
  const tasks = new Map<string, Task>();
  const resumes: Array<{ id: string; time: number; body: Record<string, unknown> }> = [];
  let loseAcknowledgement = false;
  let beforeRead: (() => Promise<void>) | undefined;
  let policyReady = true;
  const beforeResume = async () => { if (!policyReady) throw new Error("Policy unavailable"); };
  let recovery: Awaited<ReturnType<typeof createTaskRecovery>>;
  const prefix = engine === "v2" ? "/opencode2/api" : "/opencode";
  const respond = (data: unknown) => Response.json(engine === "v2" ? { data } : data);
  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(`/workspace/ws${prefix}`, "");
    const id = path.match(/(?:\/api)?\/session\/([^/]+)/)?.[1] ?? "";
    if (req.method === "POST") {
      if (path.endsWith("/abort") || path.endsWith("/interrupt")) {
        const task = tasks.get(id);
        if (task) { task.active = false; task.aborted = true; }
        return respond(true);
      }
      const body = await req.json();
      const recovering = JSON.stringify(body).includes("Continue the interrupted task");
      const task = tasks.get(id) ?? { active: true, blocked: false, completed: false, aborted: false, user: 0 };
      task.user++; task.active = true; task.completed = false; task.aborted = false;
      tasks.set(id, task);
      if (recovering) {
        resumes.push({ id, time: Date.now(), body });
        if (loseAcknowledgement) throw new Error("Acknowledgement lost");
      }
      return new Response(null, { status: 204 });
    }
    await beforeRead?.();
    if (path === "/session/status" || path === "/session/active") return respond(Object.fromEntries(
      [...tasks].filter(([, task]) => task.active).map(([id]) => [id, { type: engine === "v2" ? "running" : "busy" }]),
    ));
    if (path === "/permission" || path === "/question" || path === "/form/request") return respond(
      path === "/permission" ? [...tasks].filter(([, task]) => task.blocked).map(([id]) => ({ id: `p-${id}`, sessionID: id })) : [],
    );
    const task = tasks.get(id);
    if (!task) return new Response(null, { status: 404 });
    if (path.endsWith("/permission")) {
      const data = task.blocked ? [{ id: `p-${id}`, sessionID: id }] : [];
      return engine === "v1" ? Response.json({ data }) : respond(data);
    }
    if (path.endsWith("/message") || path.endsWith("/context")) {
      const messages = [
        { id: `user-${task.user}`, role: "user", type: "user", model: { providerID: "test", modelID: "test" }, agent: "build", variant: "high" },
        { id: `assistant-${task.user}`, role: "assistant", type: "assistant", time: task.completed || task.aborted ? { completed: 1 } : {},
          ...(task.aborted ? { error: { name: "MessageAbortedError" } } : {}) },
      ];
      const parts = task.delegated ? [{ type: "tool", name: "subagent", tool: "task", state: { status: "running" } }] : [];
      return respond(engine === "v2" ? messages.map((message) => ({ ...message, content: parts })) : messages.map((info) => ({ info, parts })));
    }
    return respond({ id, directory: root, location: { directory: root }, time: {},
      ...(engine === "v2" ? { outcome: task.completed ? "succeeded" : task.aborted ? "interrupted" : null } : {}) });
  };
  const request = (req: Request): Promise<Response> => recovery.forward(workspace, engine,
    new URL(req.url).pathname.replace("/workspace/ws", ""), req, () => handle(req));
  recovery = await createTaskRecovery(config, request, beforeResume);
  cleanups.push(async () => {
    await recovery.stop();
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  });
  let now = Date.now();
  const tick = async () => { now += RECOVERY_INTERVAL_MS; setSystemTime(now); await recovery.tick(); };
  return {
    tasks, resumes, tick, config,
    readHook(hook?: () => Promise<void>) { beforeRead = hook; },
    policy(ready: boolean) { policyReady = ready; },
    loseAck() { loseAcknowledgement = true; },
    async send(id: string, stop = false, optOut = false) {
      return request(new Request(`http://localhost/workspace/ws${prefix}/session/${id}/${stop ? engine === "v2" ? "interrupt" : "abort" : engine === "v2" ? "prompt" : "prompt_async"}`, {
        method: "POST", headers: { "content-type": "application/json", ...(optOut ? { "x-openwork-task-recovery": "off" } : {}) }, body: JSON.stringify({ text: "Do the task" }),
      }));
    },
    async restart(aborted = false) {
      await recovery.stop();
      for (const task of tasks.values()) { task.active = false; if (aborted) task.aborted = true; }
      recovery = await createTaskRecovery(config, request, beforeResume);
    },
    async crash(aborted = false) {
      const journal = createWorkspaceKvStore<unknown[]>({ tableName: "desktop_task_recovery", valueColumn: "state_json", parse: JSON.parse, serialize: JSON.stringify });
      const saved = await journal.getRow(config, "desktop");
      await recovery.stop();
      if (saved) await journal.setSerialized(config, "desktop", saved.valueJson, Date.now());
      for (const task of tasks.values()) { task.active = false; task.aborted = aborted; }
      recovery = await createTaskRecovery(config, request, beforeResume);
    },
  };
}

for (const engine of ["v1", "v2"] as const) {
  test(`${engine}: a durable unfinished task resumes once on its original engine and survives a second restart`, async () => {
    const f = await fixture(engine);
    await f.send("ses_work"); await f.tick();
    await f.restart(true); await f.tick();
    expect(f.resumes).toHaveLength(1);
    expect(f.resumes[0].id).toBe("ses_work");
    if (engine === "v1") expect(f.resumes[0].body).toMatchObject({ model: { providerID: "test", modelID: "test" }, agent: "build", variant: "high" });
    await f.tick();
    expect(f.resumes).toHaveLength(1);
    await f.restart(true); await f.tick();
    expect(f.resumes).toHaveLength(2);
  });

  test(`${engine}: stopped, completed, blocked, unknown, automation, and newer turns are never replayed`, async () => {
    const f = await fixture(engine);
    for (const id of ["stopped", "completed", "blocked", "newer", "unknown"]) await f.send(id);
    await f.send("automation", false, true);
    for (let i = 0; i < 3; i++) await f.tick();
    await f.send("stopped", true);
    f.tasks.get("blocked")!.blocked = true;
    f.tasks.get("completed")!.completed = true;
    await f.restart();
    f.tasks.get("newer")!.user++;
    f.tasks.get("unknown")!.completed = true;
    for (let i = 0; i < 5; i++) await f.tick();
    expect(f.resumes.map((item) => item.id)).not.toContain("stopped");
    expect(f.resumes.map((item) => item.id)).not.toContain("completed");
    expect(f.resumes.map((item) => item.id)).not.toContain("blocked");
    expect(f.resumes.map((item) => item.id)).not.toContain("newer");
    expect(f.resumes.map((item) => item.id)).not.toContain("automation");
    expect(f.resumes.map((item) => item.id)).not.toContain("unknown");
  });

  test(`${engine}: starts are spaced and at most two recovered tasks run at once`, async () => {
    const f = await fixture(engine);
    for (let i = 0; i < 6; i++) { await f.send(`ses_${i}`); await f.tick(); }
    await f.restart();
    for (let i = 0; i < 8; i++) await f.tick();
    expect(f.resumes).toHaveLength(2);
    expect(f.resumes[1].time - f.resumes[0].time).toBeGreaterThanOrEqual(RECOVERY_INTERVAL_MS);
    const first = f.tasks.get(f.resumes[0].id)!;
    first.active = false; first.completed = true;
    for (let i = 0; i < 6; i++) await f.tick();
    expect(f.resumes).toHaveLength(3);
  });

  test(`${engine}: manual Stop during reconciliation cancels the pending resume`, async () => {
    const f = await fixture(engine);
    await f.send("ses_work"); await f.tick(); await f.restart();
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    f.readHook(() => held);
    const ticking = f.tick();
    await f.send("ses_work", true);
    release(); await ticking; f.readHook();
    expect(f.resumes).toEqual([]);
  });

  test(`${engine}: a lost recovery acknowledgement is not resent on restart`, async () => {
    const f = await fixture(engine);
    await f.send("ses_work"); await f.tick(); await f.restart();
    f.loseAck(); await f.tick();
    expect(f.resumes).toHaveLength(1);
    await f.restart(); await f.tick();
    expect(f.resumes).toHaveLength(1);
  });

  test(`${engine}: a natively recovered active run is observed without a second prompt`, async () => {
    const f = await fixture(engine);
    await f.send("ses_work"); await f.tick(); await f.restart();
    f.tasks.get("ses_work")!.active = true;
    await f.tick();
    expect(f.resumes).toEqual([]);
  });

  test(`${engine}: crash recovery requires a still-unfinished turn, not an unexplained abort`, async () => {
    const f = await fixture(engine);
    await f.send("ses_work"); await f.tick(); await f.crash(); await f.tick();
    expect(f.resumes).toHaveLength(1);
    await f.tick(); await f.crash(true); await f.tick();
    expect(f.resumes).toHaveLength(1);
  });

  test(`${engine}: shutdown checkpoints a just-admitted task before the first poll`, async () => {
    const f = await fixture(engine);
    await f.send("ses_work"); await f.restart(true); await f.tick();
    expect(f.resumes).toHaveLength(1);
  });

  test(`${engine}: startup waits for policy restoration before claiming a continuation`, async () => {
    const f = await fixture(engine);
    await f.send("ses_work"); await f.restart(); f.policy(false);
    await f.tick(); await f.tick();
    expect(f.resumes).toHaveLength(0);
    f.policy(true); await f.tick();
    expect(f.resumes).toHaveLength(1);
  });

  test(`${engine}: delegated work is excluded and native active work counts against the startup limit`, async () => {
    const f = await fixture(engine);
    await f.send("ses_child_owner"); f.tasks.get("ses_child_owner")!.delegated = true;
    await f.send("ses_work"); await f.restart();
    f.tasks.set("external-a", { active: true, blocked: false, completed: false, aborted: false, user: 1 });
    f.tasks.set("external-b", { active: true, blocked: false, completed: false, aborted: false, user: 1 });
    await f.tick();
    expect(f.resumes).toEqual([]);
    f.tasks.delete("external-b"); await f.tick();
    expect(f.resumes.map((item) => item.id)).toEqual(["ses_work"]);
  });

  test(`${engine}: removed or retargeted workspaces never inherit a recovery request`, async () => {
    const f = await fixture(engine);
    await f.send("ses_work"); await f.restart();
    f.config.workspaces[0].path += "-different";
    await f.tick();
    expect(f.resumes).toEqual([]);
  });
}
