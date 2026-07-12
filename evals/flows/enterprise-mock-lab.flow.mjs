import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FLOW_ID = "enterprise-mock-lab";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILE_ID = "servicenow-inbound-quickstart";
const FAULT_ID = "provider-authorization-denied";
const EXPECTED_PHASE = "PROVIDER_AUTHORIZATION";
const EXPECTED_CATEGORY = "provider_authorization_denied";
const INSTANCE_NAME = "ServiceNow standalone proof";
const SAFE_CHILD_ENV_KEYS = [
  "APPDATA",
  "CI",
  "ComSpec",
  "COREPACK_HOME",
  "FORCE_COLOR",
  "HOME",
  "LOCALAPPDATA",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "WINDIR",
];

// These values exist only for the child process created by this flow. They have
// no authority outside the local mock and are never written to evidence.
const ADMIN_SECRET = `synthetic-lab-admin-${randomBytes(24).toString("hex")}`;
const CLIENT_SECRET = `synthetic-oauth-client-${randomBytes(12).toString("hex")}`;

const state = {
  child: null,
  controlOrigin: null,
  controlPort: null,
  dataPort: null,
  dataPlaneBaseUrl: null,
  exitHandler: null,
  instanceId: null,
  processOutput: "",
};

function safeProcessOutput(value) {
  return String(value)
    .replaceAll(ADMIN_SECRET, "[REDACTED]")
    .replaceAll(CLIENT_SECRET, "[REDACTED]")
    .slice(-8_000);
}

function rememberProcessOutput(chunk) {
  state.processOutput = safeProcessOutput(`${state.processOutput}${String(chunk)}`);
}

function childEnvironment() {
  return Object.fromEntries(
    SAFE_CHILD_ENV_KEYS
      .map((key) => [key, process.env[key]])
      .filter((entry) => typeof entry[1] === "string"),
  );
}

function signalLabProcess(signal) {
  if (!state.child) return;
  try {
    if (process.platform !== "win32" && state.child.pid) process.kill(-state.child.pid, signal);
    else if (state.child.exitCode === null && state.child.signalCode === null) state.child.kill(signal);
  } catch {
    // The process may have exited between the state check and the signal.
  }
}

function witness(ctx, condition, assertion, actual) {
  const detail = actual === undefined
    ? undefined
    : typeof actual === "string"
      ? actual
      : JSON.stringify(actual).slice(0, 1_200);
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: detail,
  });
  ctx.assert(condition, `${assertion}${detail === undefined ? "" : ` (actual: ${detail})`}`);
}

async function freeLoopbackPort(excluded = new Set()) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const selected = typeof address === "object" && address ? address.port : null;
        server.close((error) => error ? reject(error) : resolve(selected));
      });
    });
    if (typeof port === "number" && !excluded.has(port)) return port;
  }
  throw new Error("Could not reserve distinct loopback ports for the standalone lab proof.");
}

async function healthResponse() {
  if (!state.controlOrigin) return null;
  try {
    return await fetch(`${state.controlOrigin}/health`, { signal: AbortSignal.timeout(1_000) });
  } catch {
    return null;
  }
}

async function startLab(ctx) {
  state.controlPort = await freeLoopbackPort();
  state.dataPort = await freeLoopbackPort(new Set([state.controlPort]));
  state.controlOrigin = `http://127.0.0.1:${state.controlPort}`;
  state.processOutput = "";

  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  state.child = spawn(command, [
    "--filter",
    "@openwork-ee/enterprise-mock-lab",
    "dev",
  ], {
    cwd: ROOT,
    env: {
      ...childEnvironment(),
      ENTERPRISE_MOCK_LAB_ADMIN_SECRET: ADMIN_SECRET,
      ENTERPRISE_MOCK_LAB_HOST: "127.0.0.1",
      ENTERPRISE_MOCK_LAB_PORT: String(state.controlPort),
      ENTERPRISE_MOCK_LAB_SESSION_TTL_SECONDS: "600",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child.stdout?.on("data", rememberProcessOutput);
  state.child.stderr?.on("data", rememberProcessOutput);
  state.child.once("error", rememberProcessOutput);
  state.exitHandler = () => {
    signalLabProcess("SIGKILL");
  };
  process.once("exit", state.exitHandler);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    const response = await healthResponse();
    if (response?.ok) {
      const body = await response.json();
      witness(ctx, body?.service === "enterprise-mock-lab" && body?.exposure === "loopback-only", "The child process identifies itself as the loopback-only Enterprise Mock Lab", body);
      ctx.output("Standalone lab process", `control=${state.controlOrigin}\ndata-plane-port=${state.dataPort}\nprofile=${PROFILE_ID}\nsecrets=synthetic and redacted`);
      return;
    }
    if (state.child.exitCode !== null) {
      throw new Error(`The Enterprise Mock Lab exited before becoming healthy.\n${safeProcessOutput(state.processOutput)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`The Enterprise Mock Lab did not become healthy within 20 seconds.\n${safeProcessOutput(state.processOutput)}`);
}

async function stopLab(ctx) {
  const child = state.child;
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    signalLabProcess("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    signalLabProcess("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  let response = await healthResponse();
  if (response !== null) {
    signalLabProcess("SIGKILL");
    const startedAt = Date.now();
    while (response !== null && Date.now() - startedAt < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      response = await healthResponse();
    }
  }
  if (state.exitHandler) process.removeListener("exit", state.exitHandler);
  if (ctx) witness(ctx, response === null, "The standalone control-plane listener is closed after cleanup", response?.status);
  state.child = null;
  state.exitHandler = null;
}

async function navigate(ctx, url) {
  await ctx.client.send("Page.navigate", { url });
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 20_000, label: `load ${url}` });
}

async function selectValue(ctx, selector, value) {
  const selected = await ctx.eval(`(() => {
    const select = document.querySelector(${JSON.stringify(selector)});
    if (!(select instanceof HTMLSelectElement)) return null;
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value;
  })()`);
  witness(ctx, selected === value, `The ${selector} control accepts the requested declarative value`, selected);
}

async function clickInstanceButton(ctx, label) {
  const selector = `#instance-${state.instanceId}`;
  const clicked = await ctx.waitFor(`(() => {
    const card = document.querySelector(${JSON.stringify(selector)});
    const button = [...(card?.querySelectorAll("button") ?? [])]
      .find((candidate) => (candidate.textContent ?? "").trim() === ${JSON.stringify(label)} && !candidate.disabled);
    if (!button) return null;
    button.scrollIntoView({ block: "center" });
    button.click();
    return button.textContent.trim();
  })()`, { timeoutMs: 10_000, label: `${label} button for ${INSTANCE_NAME}` });
  ctx.log(`Clicked instance action: ${clicked}`);
}

async function scrollInstancePart(ctx, selector = "", block = "center") {
  const visibility = await ctx.eval(`(() => {
    const card = document.querySelector(${JSON.stringify(`#instance-${state.instanceId}`)});
    const target = ${selector ? `card?.querySelector(${JSON.stringify(selector)})` : "card"} ?? card;
    target?.scrollIntoView({ block: ${JSON.stringify(block)}, behavior: "instant" });
    if (!target) return { found: false, visible: false };
    const rect = target.getBoundingClientRect();
    return { found: true, visible: rect.top < innerHeight && rect.bottom > 0, top: Math.round(rect.top), bottom: Math.round(rect.bottom), viewport: innerHeight };
  })()`);
  witness(ctx, visibility?.found === true && visibility?.visible === true, `The screenshot target '${selector || "instance card"}' is inside the visible viewport`, visibility);
}

async function scrollDocumentPart(ctx, selector, block = "center") {
  const visibility = await ctx.eval(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    target?.scrollIntoView({ block: ${JSON.stringify(block)}, behavior: "instant" });
    if (!target) return { found: false, visible: false };
    const rect = target.getBoundingClientRect();
    return { found: true, visible: rect.top < innerHeight && rect.bottom > 0, top: Math.round(rect.top), bottom: Math.round(rect.bottom), viewport: innerHeight };
  })()`);
  witness(ctx, visibility?.found === true && visibility?.visible === true, `The screenshot target '${selector}' is inside the visible viewport`, visibility);
}

async function readInstance(ctx) {
  return ctx.eval(`fetch(${JSON.stringify(`/api/v1/instances/${state.instanceId}`)}, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }).then(async (response) => {
    const body = await response.json();
    if (!response.ok) throw new Error(body?.message ?? "Instance read failed");
    return body;
  })`, { awaitPromise: true });
}

async function dataPlaneIsClosed() {
  if (!state.dataPlaneBaseUrl) return true;
  try {
    await fetch(`${state.dataPlaneBaseUrl}/health`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

async function waitForDataPlaneClosed() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (await dataPlaneIsClosed()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function emergencyCleanup(ctx) {
  if (state.instanceId && state.child && state.child.exitCode === null) {
    try {
      await ctx.eval(`(() => {
        const csrfToken = document.querySelector('input[name="csrfToken"]')?.value;
        if (!csrfToken) return false;
        return fetch(${JSON.stringify(`/api/v1/instances/${state.instanceId}/actions/delete`)}, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: "{}",
        }).then((response) => response.ok);
      })()`, { awaitPromise: true });
    } catch {
      // The process shutdown below owns the final cleanup if the browser is no
      // longer authenticated or a navigation was interrupted.
    }
  }
  await stopLab(null).catch(() => undefined);
}

function guarded(run) {
  return async (ctx) => {
    try {
      await run(ctx);
    } catch (error) {
      await emergencyCleanup(ctx);
      throw error;
    }
  };
}

export default {
  id: FLOW_ID,
  title: "Standalone Enterprise Mock Lab identifies a ServiceNow provider authorization failure and recovers",
  kind: "user-facing",
  preserveTheme: true,
  spec: "docs/enterprise-mock-lab.md#manual-ui-verification",
  steps: [
    {
      name: "Launch and unlock an isolated lab",
      run: guarded(async (ctx) => {
        await ctx.prove("The proof starts a private lab process without Den or a real provider", {
          action: async () => {
            await startLab(ctx);
            await navigate(ctx, state.controlOrigin);
            await ctx.waitForText("Enterprise Mock Lab", { timeoutMs: 10_000 });
            await ctx.fill("#admin-secret", ADMIN_SECRET);
            await ctx.clickText("Unlock local lab", { selector: "button" });
            await ctx.waitForText("Create an enterprise MCP simulation", { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText("PRIVATE LOOPBACK CONTROL PLANE");
            await ctx.expectText("No instances yet");
            await ctx.expectText("Profile provenance");
            const location = await ctx.eval("location.origin");
            witness(ctx, location === state.controlOrigin, "The browser is on the standalone lab origin", location);
            await scrollDocumentPart(ctx, ".empty-state");
          },
          screenshot: {
            name: "empty-loopback-lab",
            requireText: ["Mock instances", "No instances yet", "Create one above"],
            rejectText: ["Something went wrong"],
          },
        });
      }),
    },
    {
      name: "Create and start a ServiceNow-style data plane",
      run: guarded(async (ctx) => {
        await ctx.prove("A ServiceNow simulation starts on its own provider-facing listener with write-only synthetic secrets", {
          action: async () => {
            await ctx.fill("#display-name", INSTANCE_NAME);
            await selectValue(ctx, "#profile-id", PROFILE_ID);
            await ctx.fill("#port", String(state.dataPort));
            await ctx.fill("#client-id", "synthetic-openwork-proof-client");
            await ctx.fill("#client-secret", CLIENT_SECRET);
            await ctx.clickText("Create stopped instance", { selector: "button" });
            await ctx.waitForText(INSTANCE_NAME, { timeoutMs: 10_000 });
            state.instanceId = await ctx.eval(`document.querySelector("article.instance-card")?.id?.replace("instance-", "") ?? null`);
            witness(ctx, typeof state.instanceId === "string" && state.instanceId.length > 10, "The control plane returned a stable instance identifier", state.instanceId);
            await clickInstanceButton(ctx, "Start");
            await ctx.waitFor(`document.querySelector(${JSON.stringify(`#instance-${state.instanceId}`)})?.innerText.includes("RUNNING")`, {
              timeoutMs: 15_000,
              label: "ServiceNow mock instance running",
            });
            await scrollInstancePart(ctx, ".instance-header", "start");
          },
          assert: async () => {
            const instance = await readInstance(ctx);
            state.dataPlaneBaseUrl = instance.endpoint?.baseUrl ?? null;
            witness(ctx, instance.state === "running", "The instance lifecycle is running", instance.state);
            witness(ctx, instance.profile?.id === PROFILE_ID, "The running data plane uses the ServiceNow inbound Quickstart profile", instance.profile?.id);
            witness(ctx, instance.scenarioRevision === 1 && instance.activeFault === null, "Revision 1 is the healthy baseline", { revision: instance.scenarioRevision, activeFault: instance.activeFault });
            witness(ctx, instance.endpoint?.mcpUrl?.endsWith("/sncapps/mcp-server/mcp/sn_mcp_server_default"), "The data-plane URL uses the ServiceNow-style Quickstart MCP path", instance.endpoint?.mcpUrl);
            witness(ctx, instance.secretsConfigured?.clientSecret === true, "The synthetic OAuth client secret is represented only by a configured boolean", instance.secretsConfigured);
            const serialized = JSON.stringify(instance);
            witness(ctx, !serialized.includes(CLIENT_SECRET) && !serialized.includes(ADMIN_SECRET), "No synthetic secret is returned by the instance API");
            ctx.output("Running ServiceNow-style instance", JSON.stringify({
              id: instance.id,
              profile: instance.profile.id,
              state: instance.state,
              revision: instance.scenarioRevision,
              mcpUrl: instance.endpoint.mcpUrl,
              secretsConfigured: instance.secretsConfigured,
            }, null, 2));
          },
          screenshot: {
            name: "servicenow-instance-running",
            requireText: [INSTANCE_NAME, "RUNNING", "ServiceNow Inbound MCP Quickstart", "Healthy baseline", "Configured (write-only)"],
            rejectText: ["Something went wrong"],
          },
        });
      }),
    },
    {
      name: "Inject and prove the first provider authorization failure",
      run: guarded(async (ctx) => {
        await ctx.prove("The lab distinguishes a provider ACL denial from OAuth, transport, and MCP lifecycle failures", {
          action: async () => {
            await selectValue(ctx, `#fault-${state.instanceId}-select`, FAULT_ID);
            await clickInstanceButton(ctx, "Apply new revision");
            await ctx.waitFor(`document.querySelector(${JSON.stringify(`#instance-${state.instanceId}`)})?.innerText.includes(${JSON.stringify("Scenario revision\n2")})`, {
              timeoutMs: 10_000,
              label: "scenario revision 2",
            });
            await clickInstanceButton(ctx, "Run probe");
            await ctx.waitFor(`document.querySelector(${JSON.stringify(`#instance-${state.instanceId}`)})?.innerText.includes("Expectation matched")`, {
              timeoutMs: 20_000,
              label: "fault probe expectation match",
            });
            await scrollInstancePart(ctx, ".comparison", "start");
          },
          assert: async () => {
            const instance = await readInstance(ctx);
            const probe = instance.lastProbe;
            witness(ctx, instance.scenarioRevision === 2, "Activating the fault creates immutable scenario revision 2", instance.scenarioRevision);
            witness(ctx, instance.activeFault?.id === FAULT_ID, "The named provider authorization fault is active", instance.activeFault?.id);
            witness(ctx, probe?.matchesExpectation === true, "Observed wire behavior matches the declarative fault expectation", probe);
            witness(ctx, probe?.expected?.outcome === "failure" && probe?.observed?.outcome === "failure", "Both expected and observed outcomes are failures", probe);
            witness(ctx, probe?.expected?.firstFailedPhase === EXPECTED_PHASE && probe?.observed?.firstFailedPhase === EXPECTED_PHASE, "The first failed phase is specifically PROVIDER_AUTHORIZATION", probe);
            witness(ctx, probe?.expected?.category === EXPECTED_CATEGORY && probe?.observed?.category === EXPECTED_CATEGORY, "The error source is specifically provider_authorization_denied", probe);
            ctx.output("First failure proof", JSON.stringify(probe, null, 2));
          },
          screenshot: {
            name: "provider-authorization-first-failure",
            requireText: ["Expectation matched", "Observed:", EXPECTED_PHASE, EXPECTED_CATEGORY],
            rejectText: ["INVESTIGATE", "Something went wrong"],
          },
        });
      }),
    },
    {
      name: "Reset runtime evidence without hiding the configured fault",
      run: guarded(async (ctx) => {
        await ctx.prove("Reset is explicit: it clears the previous probe while preserving the selected scenario revision", {
          action: async () => {
            await clickInstanceButton(ctx, "Reset");
            await ctx.waitFor(`(() => {
              const text = document.querySelector(${JSON.stringify(`#instance-${state.instanceId}`)})?.innerText ?? "";
              return text.includes("Provider ACL denied") && text.includes("Run a probe to compare");
            })()`, { timeoutMs: 10_000, label: "reset instance with fault retained" });
            await scrollInstancePart(ctx, ".comparison", "start");
          },
          assert: async () => {
            const instance = await readInstance(ctx);
            witness(ctx, instance.state === "running", "Reset keeps the data-plane listener running", instance.state);
            witness(ctx, instance.scenarioRevision === 2 && instance.activeFault?.id === FAULT_ID, "Reset does not silently change the declared scenario", { revision: instance.scenarioRevision, fault: instance.activeFault?.id });
            witness(ctx, instance.lastProbe === null, "Reset clears the previous expected-versus-observed probe", instance.lastProbe);
          },
          screenshot: {
            name: "reset-preserves-declared-fault",
            requireText: ["Provider ACL denied", "Scenario revision", "Run a probe to compare"],
            rejectText: ["Expectation matched", "Something went wrong"],
          },
        });
      }),
    },
    {
      name: "Apply a healthy revision and prove recovery",
      run: guarded(async (ctx) => {
        await ctx.prove("A new healthy revision recovers the same endpoint and proves no failed phase remains", {
          action: async () => {
            await selectValue(ctx, `#fault-${state.instanceId}-select`, "");
            await clickInstanceButton(ctx, "Apply new revision");
            await ctx.waitFor(`document.querySelector(${JSON.stringify(`#instance-${state.instanceId}`)})?.innerText.includes(${JSON.stringify("Scenario revision\n3")})`, {
              timeoutMs: 10_000,
              label: "healthy scenario revision 3",
            });
            await clickInstanceButton(ctx, "Run probe");
            await ctx.waitFor(`document.querySelector(${JSON.stringify(`#instance-${state.instanceId}`)})?.innerText.includes("Expectation matched")`, {
              timeoutMs: 20_000,
              label: "healthy probe expectation match",
            });
            await scrollInstancePart(ctx, ".comparison-section");
          },
          assert: async () => {
            const instance = await readInstance(ctx);
            const probe = instance.lastProbe;
            witness(ctx, instance.scenarioRevision === 3 && instance.activeFault === null, "Revision 3 is an explicit healthy baseline", { revision: instance.scenarioRevision, activeFault: instance.activeFault });
            witness(ctx, probe?.matchesExpectation === true, "The recovered wire behavior matches the healthy expectation", probe);
            witness(ctx, probe?.expected?.outcome === "success" && probe?.observed?.outcome === "success", "Both expected and observed outcomes are healthy", probe);
            witness(ctx, probe?.expected?.firstFailedPhase === null && probe?.observed?.firstFailedPhase === null, "No first failed phase remains after recovery", probe);
            witness(ctx, probe?.expected?.category === null && probe?.observed?.category === null, "No error category remains after recovery", probe);
            ctx.output("Healthy recovery proof", JSON.stringify(probe, null, 2));
          },
          screenshot: {
            name: "healthy-recovery-matched",
            requireText: ["Expectation matched", "Healthy baseline", "success", "None"],
            rejectText: [EXPECTED_CATEGORY, "INVESTIGATE", "Something went wrong"],
          },
        });
      }),
    },
    {
      name: "Delete the instance and close both listeners",
      run: guarded(async (ctx) => {
        await ctx.prove("Cleanup removes the data plane and leaves the lab with no retained instance", {
          action: async () => {
            await clickInstanceButton(ctx, "Delete");
            await ctx.waitForText("No instances yet", { timeoutMs: 10_000 });
            const closed = await waitForDataPlaneClosed();
            witness(ctx, closed, "Deleting the instance closes its provider-facing data-plane listener", state.dataPlaneBaseUrl);
            state.instanceId = null;
            await scrollDocumentPart(ctx, ".empty-state");
          },
          assert: async () => {
            const instances = await ctx.eval(`fetch("/api/v1/instances", { credentials: "same-origin" }).then((response) => response.json())`, { awaitPromise: true });
            witness(ctx, Array.isArray(instances?.instances) && instances.instances.length === 0, "The control plane retains no instance after deletion", instances);
            await ctx.expectText("No instances yet");
          },
          screenshot: {
            name: "standalone-lab-clean",
            requireText: ["Mock instances", "No instances yet", "Create one above"],
            rejectText: [INSTANCE_NAME, "Something went wrong"],
          },
        });
        await stopLab(ctx);
      }),
    },
  ],
};
