import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  app, browserScript, eventually, faultProxy, mcpMock, needs,
  readDenClientState, resolveEvalEngine, server, test,
} from "@openwork/testkit";
import { control, engineSessionProbe, evalIn, selectModel, waitFor, writeComposerText } from "@openwork/behaviors";
import { checkedExec, defaultDaytonaExec } from "@openwork/hosts";
import type { App } from "@openwork/testkit";

const providerId = "policy-outage-witness";
const modelId = "policy-outage-model";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function configureModel(surface: App, workspaceId: string, modelUrl: string) {
  const configured = await evalIn(surface, browserScript(async (workspaceId, modelUrl, providerId, modelId) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.baseUrl) throw new Error("The local desktop server is not running");
    const headers = { Authorization: `Bearer ${info.ownerToken}`, "Content-Type": "application/json" };
    const root = info.baseUrl.replace(/\/$/, "");
    const response = await fetch(`${root}/workspace/${workspaceId}/config`, {
      method: "PATCH", headers, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ opencode: {
        model: `${providerId}/${modelId}`,
        small_model: `${providerId}/${modelId}`,
        permission: { bash: "allow" },
        provider: { [providerId]: {
          npm: "@ai-sdk/openai-compatible", name: "Policy outage witness",
          options: { baseURL: `${modelUrl}/v1`, apiKey: "fixture-only-policy-outage" },
          models: { [modelId]: { name: "Policy outage model", tool_call: true } },
        } },
      } }),
    });
    if (!response.ok) throw new Error(`Workspace provider configuration failed: ${response.status}`);
    const reload = await fetch(`${root}/workspace/${workspaceId}/engine/reload`, {
      method: "POST", headers, signal: AbortSignal.timeout(60_000),
    });
    if (!reload.ok) throw new Error(`Engine reload failed: ${reload.status}`);
    localStorage.setItem("openwork.defaultModel", `${providerId}/${modelId}`);
    return { configured: response.status, reloaded: reload.status };
  }, [workspaceId, modelUrl, providerId, modelId]), { awaitPromise: true, timeoutMs: 120_000 });
  expect(configured).toEqual({ configured: 200, reloaded: 200 });
  await evalIn(surface, () => { location.reload(); });
  await waitFor(surface, () => Boolean(window.__openworkControl), { timeoutMs: 60_000, label: "configured signed-in desktop restored" });
}

async function runtimePlugins(surface: App, workspaceId: string): Promise<string[]> {
  const result = await evalIn(surface, browserScript(async (workspaceId) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.baseUrl) throw new Error("The local desktop server is not running");
    const response = await fetch(`${info.baseUrl.replace(/\/$/, "")}/workspace/${workspaceId}/opencode/config`, {
      headers: { Authorization: `Bearer ${info.ownerToken}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Native runtime configuration read failed: ${response.status}`);
    const config: unknown = await response.json();
    if (typeof config !== "object" || config === null || !("plugin" in config) || !Array.isArray(config.plugin)) {
      throw new Error("Native runtime config did not expose its plugin registration list");
    }
    // Never return provider configuration or credentials into test evidence.
    return config.plugin.filter((entry: unknown): entry is string => typeof entry === "string");
  }, [workspaceId]), { awaitPromise: true, timeoutMs: 25_000 });
  expect(result.length).toBeGreaterThan(0);
  expect(result.some((plugin) => /openwork-(?:chrome|extensions|capabilities)/.test(plugin))).toBe(true);
  expect(result.filter((plugin) => /(?:^|\/)managed-policy(?:-next)?(?:\.[cm]?[jt]s|\/|$)/.test(plugin))).toEqual([]);
  return result;
}

test("an admitted signed-in desktop turn executes its next bash tool while Den returns 503, without a managed-policy plugin", { timeout: 1_200_000 }, async ({ place, evidence }) => {
  needs({ placement: "daytona", commands: ["daytona"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  expect(resolveEvalEngine(), "this HTTP-hook regression journey targets OpenCode v1").toBe("v1");
  const id = randomUUID();
  const marker = `POLICY-UNREACHABLE-${id}`;
  const workspacePath = `/tmp/openwork-policy-unreachable-${id}`;
  const readyPath = `${workspacePath}/baseline-ready.txt`;
  const releasePath = `${workspacePath}/release-gate.txt`;
  const outputPath = `${workspacePath}/outage-result.txt`;
  const unrelatedPath = `${workspacePath}/unrelated.txt`;
  const readyText = `healthy-tool-started-${id}`;
  const resultText = `tool-ran-during-den-outage-${id}`;
  const unrelatedText = `must-not-change-${id}`;
  const gateCommand = `printf '%s' ${quote(readyText)} > ${quote(readyPath)}; for attempt in $(seq 1 600); do if [ -f ${quote(releasePath)} ]; then exit 0; fi; sleep 0.2; done; exit 72`;
  const witnessCommand = `printf '%s' ${quote(resultText)} > ${quote(outputPath)}`;
  const finalReply = "The local shell work completed during the policy-service outage.";

  await using den = await server({
    place,
    org: { name: "Policy Outage Proof", admin: { name: "Fixture Admin" }, members: { member: { name: "Fixture Member" } } },
    mocks: { agent: mcpMock({ agentWorkloads: [{ promptMarker: marker, finalReply, steps: [
      { tool: "bash", arguments: { command: gateCommand, timeout: 180_000, description: "Hold an admitted turn at the outage boundary" } },
      { tool: "bash", arguments: { command: witnessCommand, timeout: 15_000, description: "Write the local result during the Den outage" } },
    ] }] }) },
  });
  if (den.placement?.kind !== "daytona") throw new Error("The signed-in Den fixture did not use Daytona");
  await using proxy = await faultProxy(den.ref, { place, sandbox: den.placement.sandboxId });
  // Den Web normally advertises its direct API origin. Keep discovery behind
  // this fixture's proxy too, otherwise the desktop can route around the fault.
  await proxy.faults.status("/api/runtime-config", 200, { times: 10_000, body: { denApiUrl: proxy.ref.apiUrl } });
  await using desktop = await app({ den: { ...den, ref: proxy.ref }, as: "member", place, workspacePath });
  const sandboxId = desktop.handle.sandboxId;
  if (!sandboxId) throw new Error("The desktop did not report its isolated Daytona sandbox");
  console.info(`Policy outage Electron log: ${desktop.handle.meta?.log}; sandbox: ${sandboxId}`);
  const remoteNode = async (source: string) => {
    const result = await checkedExec(defaultDaytonaExec,
      ["exec", sandboxId, "--", `bash -lc ${quote(`node --input-type=module -e ${quote(source)}`)}`],
      "isolated policy-outage file witness", { timeoutMs: 30_000 });
    const value: unknown = JSON.parse(result.stdout.trim());
    return value;
  };
  const files = async () => {
    const value = await remoteNode(`import { readFile } from 'node:fs/promises';
      const read = async path => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
      console.log(JSON.stringify({ready: await read(${JSON.stringify(readyPath)}), release: await read(${JSON.stringify(releasePath)}), output: await read(${JSON.stringify(outputPath)}), unrelated: await read(${JSON.stringify(unrelatedPath)})}));`);
    if (!record(value)) throw new Error("File witness returned malformed data");
    return value;
  };
  await remoteNode(`import { mkdir, writeFile } from 'node:fs/promises'; await mkdir(${JSON.stringify(workspacePath)}, {recursive:true}); await writeFile(${JSON.stringify(unrelatedPath)}, ${JSON.stringify(unrelatedText)}, {flag:'wx'}); console.log('true');`);
  await configureModel(desktop, desktop.workspaceId, den.mocks.agent.url);
  const beforeIdentity = await readDenClientState(desktop);
  expect(beforeIdentity.authTokenPresent).toBe(true);
  expect(beforeIdentity.activeOrgId).toBeTruthy();
  const policyBaseline = await eventually(() => evalIn(desktop, async () => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.baseUrl) throw new Error("The local desktop server is not running");
    const response = await fetch(`${info.baseUrl.replace(/\/$/, "")}/managed-policy`, {
      headers: { Authorization: `Bearer ${info.ownerToken}` }, signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json();
    return { status: response.status, hasPolicy: typeof body === "object" && body !== null && "policy" in body && body.policy !== null };
  }, { awaitPromise: true, timeoutMs: 15_000 }), {
    within: 45_000, label: "signed-in policy identity reaches the actual desktop server",
    until: (value) => value.status === 200 && value.hasPolicy,
  });
  expect(policyBaseline).toEqual({ status: 200, hasPolicy: true });
  const pluginsBefore = await runtimePlugins(desktop, desktop.workspaceId);
  const sessionId = await control(desktop, "session.create_task", undefined, { timeoutMs: 60_000 });
  if (typeof sessionId !== "string" || !sessionId.startsWith("ses_")) throw new Error("No real session was created");
  const selected = await selectModel(desktop, modelId);
  expect(selected.id).toBe(modelId);
  const native = engineSessionProbe({ engine: "v1", surface: desktop, workspaceId: desktop.workspaceId });
  const prompt = `Run the supplied local shell steps and report completion. ${marker}`;
  expect(prompt).not.toContain(sessionId);
  await writeComposerText(desktop, prompt);
  await control(desktop, "composer.send", undefined, { timeoutMs: 90_000 });
  await eventually(async () => {
    const snapshot = await native.snapshot(sessionId);
    return snapshot.ok && snapshot.data.messages.flatMap((message) => message.parts)
      .some((part) => part.tool === "bash" && part.input.command === gateCommand && part.status === "running");
  }, { within: 90_000, label: "healthy admission starts the real first shell tool", until: Boolean });
  expect(await files()).toEqual({ ready: readyText, release: null, output: null, unrelated: unrelatedText });
  const sessionsBefore = await native.list();
  expect(sessionsBefore.ok).toBe(true);

  let faultInstalled = false;
  try {
    const logStart = (await proxy.requestLog()).length;
    await proxy.faults.status("/api/den", 503, { times: 10_000, body: { error: "fixture_den_unreachable", message: "Injected Den outage" } });
    faultInstalled = true;
    const member = den.members.member;
    if (!member) throw new Error("Missing isolated fixture member");
    const probeOutage = async () => {
      const response = await fetch(`${proxy.ref.apiUrl}/v1/me/desktop-config`, {
        headers: { Authorization: `Bearer ${member.token}` }, signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      return response.status;
    };
    expect(await probeOutage()).toBe(503);
    // Calibrate the actual desktop-server -> Den path, not just a synthetic proxy probe.
    // Admission still fails closed; #4725 removes in-engine per-tool hooks, not this gate.
    const admission = await evalIn(desktop, browserScript(async (workspaceId) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.baseUrl) throw new Error("The local desktop server is not running");
      const response = await fetch(`${info.baseUrl.replace(/\/$/, "")}/workspace/${workspaceId}/opencode/session`, {
        method: "POST", headers: { Authorization: `Bearer ${info.ownerToken}`, "Content-Type": "application/json" },
        body: "{}", signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = await response.json();
      // The desktop server formats ApiError as { code, message, details }.
      return { status: response.status, code: typeof body === "object" && body !== null && "code" in body ? body.code : null };
    }, [desktop.workspaceId]), { awaitPromise: true, timeoutMs: 20_000 });
    evidence.recordJsonArtifact("Den outage calibration", { admission, policyBaseline, requests: (await proxy.requestLog()).slice(logStart) });
    expect(admission.status, "a separate new admission remains denied while Den is unreachable").toBe(403);
    expect(admission.code).toBe("policy_unavailable");
    expect((await files()).output, "the next tool must not have run before outage verification").toBeNull();
    const pluginsDuring = await runtimePlugins(desktop, desktop.workspaceId);
    expect(pluginsDuring).toEqual(pluginsBefore);
    // The fixture releases only the gate; it never writes the result file.
    await remoteNode(`import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(releasePath)}, 'release'); console.log('true');`);
    const completed = await eventually(async () => {
      const snapshot = await native.snapshot(sessionId);
      if (!snapshot.ok) return null;
      const parts = snapshot.data.messages.flatMap((message) => message.parts);
      const tools = parts.filter((part) => part.tool === "bash").map((part) => ({ command: part.input.command, status: part.status, callId: part.callId }));
      const text = parts.flatMap((part) => part.text ? [part.text] : []).join("\n");
      return { tools, text };
    }, {
      within: 90_000, label: "the next real tool and final reply complete while Den stays unavailable",
      until: (value) => value !== null && value.tools.filter((tool) => tool.command === witnessCommand && tool.status === "completed").length === 1 && value.text.includes(finalReply),
    });
    if (!completed) throw new Error("No completed native tool facts");
    expect(completed.tools.map((tool) => ({ command: tool.command, status: tool.status }))).toEqual([
      { command: gateCommand, status: "completed" }, { command: witnessCommand, status: "completed" },
    ]);
    expect(await files()).toEqual({ ready: readyText, release: "release", output: resultText, unrelated: unrelatedText });
    expect(await readDenClientState(desktop)).toEqual(beforeIdentity);
    expect(await probeOutage(), "Den is still unreachable after the tool completed").toBe(503);
    const faulted = (await proxy.requestLog()).slice(logStart).filter((request) => request.path.startsWith("/api/den"));
    expect(faulted.length).toBeGreaterThanOrEqual(3);
    expect(faulted.length).toBeLessThan(10_000);
    expect(faulted.every((request) => request.faulted && request.status === 503)).toBe(true);
    const nativeAfter = await native.list();
    expect(nativeAfter.ok).toBe(true);
    if (sessionsBefore.ok && nativeAfter.ok) {
      expect(nativeAfter.data.map((session) => session.id).sort()).toEqual(sessionsBefore.data.map((session) => session.id).sort());
    }
    await waitFor(desktop, browserScript((reply) => document.body.innerText.includes(reply), [finalReply]), { timeoutMs: 30_000, label: "outage completion reply visible in the desktop" });
    evidence.recordAssertionEvidence("An admitted signed-in turn executes the next real bash tool through a Den outage without managed-policy registration",
      JSON.stringify({ pluginRegistrations: pluginsDuring, denFaultRequests: faulted, admissionStatus: admission.status, tools: completed.tools, output: resultText, unrelatedUnchanged: true, signedIn: true }), true);
  } finally {
    if (faultInstalled) await proxy.faults.clear();
  }
});
