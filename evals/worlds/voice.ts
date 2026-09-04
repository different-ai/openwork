import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { evalIn } from "@openwork/behaviors";
import type { Place, Seed } from "@openwork/env";
import { voiceAudioFixtureSource, voiceTaskProvider } from "../packages/labs/src/mock-voice.ts";
import { arrangeControl } from "./chat.ts";

function quote(value: string) { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
const exec = promisify(execFile);

export async function voiceConversation(seed: Seed, { place }: { place: Place }) {
  const app = await seed.desktop({ name: "voice-conversation", model: "voice-task/voice-task-model" });
  let provider: { url: string; [Symbol.asyncDispose](): Promise<void> };
  if (place.kind === "daytona") {
    const sandbox = app.handle.sandboxId;
    if (!sandbox) throw new Error("Missing owned desktop sandbox");
    const prefix = `/tmp/voice-provider-${randomUUID()}`;
    const source = await readFile(new URL("../packages/labs/src/mock-voice.ts", import.meta.url), "utf8");
    const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
      + '\nexports.voiceTaskProvider().then(p => console.log(JSON.stringify({url:p.url})));';
    const command = `printf %s ${quote(Buffer.from(code).toString("base64"))} | base64 -d > ${prefix}.cjs; nohup node ${prefix}.cjs > ${prefix}.log 2>&1 & echo $! > ${prefix}.pid; for i in $(seq 1 30); do if test -s ${prefix}.log; then cat ${prefix}.log; exit 0; fi; sleep 1; done; exit 1`;
    const result = await exec("daytona", ["exec", sandbox, "--", `bash -lc ${quote(command)}`], { timeout: 60_000 });
    const line = result.stdout.split("\n").find((line) => line.trim().startsWith('{"url":'));
    if (!line) throw new Error("Voice model witness did not start in the desktop sandbox: " + result.stdout.slice(-2000));
    const { url } = JSON.parse(line);
    provider = { url, async [Symbol.asyncDispose]() {
      await exec("daytona", ["exec", sandbox, "--", `bash -lc ${quote(`kill $(cat ${prefix}.pid) 2>/dev/null || true`)}`], { timeout: 30_000 });
    } };
  } else provider = await voiceTaskProvider();
  try {
    const providerUrl = new URL(provider.url);
    const workspace = await seed.workspace(app, seed.tmpPath("voice-conversation"));
    await seed.evalIn(app, `async (workspaceId, providerUrl) => {
      const root = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const response = await fetch(root + "/workspace/" + workspaceId + "/config", {
        method: "PATCH", headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ opencode: {
          permission: { bash: "allow" },
          provider: { "voice-task": { npm: "@ai-sdk/openai-compatible", name: "Voice task provider", options: { baseURL: providerUrl + "/v1", apiKey: "fixture-key" }, models: { "voice-task-model": { name: "Voice task model", tool_call: true } } } },
        } }),
      });
      if (!response.ok) throw new Error("Could not configure fixture workspace: " + response.status);
      const reload = await fetch(root + "/workspace/" + workspaceId + "/engine/reload", { method: "POST", headers: { Authorization: "Bearer " + token } });
      if (!reload.ok && reload.status !== 504) throw new Error("Could not reload fixture engine");
      const prefs = JSON.parse(localStorage.getItem("openwork.preferences") || "{}");
      localStorage.setItem("openwork.preferences", JSON.stringify({ ...prefs, defaultModel: { providerID: "voice-task", modelID: "voice-task-model" }, providerStepCompleted: true }));
      localStorage.setItem("openwork.defaultModel", "voice-task/voice-task-model");
      localStorage.setItem("openwork.extension.enabled.openwork-voice", "1");
      location.reload();
      return true;
    }`, { args: [workspace.workspaceId, providerUrl.toString().replace(/\/$/, "")], awaitPromise: true, timeoutMs: 120_000 });
    await arrangeControl(seed, app, "session.create_task");
    const a = await seed.session(app, { title: "Voice conversation A" });
    const b = await seed.session(app, { title: "Voice conversation B" });
    await arrangeControl(seed, app, "session.open", { sessionId: a.sessionId });
    await seed.evalIn(app, voiceAudioFixtureSource);
    await arrangeControl(seed, app, "voice.panel.open");
    const fixture = (method: string, args: unknown[] = []) => seed.evalIn(app, `(method, args) => window.__voiceFixture[method](...JSON.parse(args))`, { args: [method, JSON.stringify(args)], awaitPromise: true });
    const facts = () => evalIn(app, "window.__voiceFixture.facts()");
    const messages = (sessionId: string) => evalIn(app, `(async () => {
      const workspaceId = ${JSON.stringify(workspace.workspaceId)};
      const sessionId = ${JSON.stringify(sessionId)};
      const root = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
      const response = await fetch(root + "/workspace/" + workspaceId + "/opencode/session/" + sessionId + "/message", { headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") } });
      if (!response.ok) throw new Error("Session witness read failed: " + response.status);
      const messages = await response.json();
      return messages.map(m => ({ role: m.info.role, text: m.parts.filter(p => p.type === "text").map(p => p.text).join("\n"), tools: m.parts.filter(p => p.type === "tool").map(p => ({ tool: p.tool, status: p.state.status, input: p.state.input, output: p.state.output })) }));
    })()`, { awaitPromise: true });
    return {
      app, workspace, a, b, fixture, facts, messages,
      file: (name: string) => evalIn(app, `(async () => {
        const root = "http://127.0.0.1:" + localStorage.getItem("openwork.server.port");
        const response = await fetch(root + ${JSON.stringify("/workspace/" + workspace.workspaceId + "/files/content?path=")} + encodeURIComponent(${JSON.stringify(name)}), { headers: { Authorization: "Bearer " + localStorage.getItem("openwork.server.token") } });
        return { status: response.status, body: await response.text() };
      })()`, { awaitPromise: true }),
      providerFacts: () => evalIn(app, `fetch(${JSON.stringify(provider.url + "/__facts")}).then(r => r.json())`, { awaitPromise: true }),
      async [Symbol.asyncDispose]() { await provider[Symbol.asyncDispose](); },
    };
  } catch (error) { await provider[Symbol.asyncDispose](); throw error; }
}
