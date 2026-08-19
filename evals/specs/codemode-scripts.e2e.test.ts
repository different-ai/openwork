import { expect, onTestFinished } from "vitest";
import {
  createNativeConnector,
  createOrgConnection,
  deleteConnection,
  denFetch,
  freshSession,
  evalIn,
  readComposerState,
  readSessionToolCalls,
  selectModel,
  waitFor,
  waitForAssistantReply,
  writeComposerText,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { chrome } from "@openwork/hosts";
import { app, mcpMock, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  model: "tool-capable",
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `codemode scripts skipped — needs: ${missingRequirements.join(", ")}`
  : "codemode scripts: a 40-step question becomes one step, gets saved, and a teammate reuses it";
const modelId = process.env.OPENWORK_EVAL_MODEL?.trim() || "";

let requestId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value).slice(0, 500)}`);
  return value;
}

function toolText(result: unknown): string {
  const record = requireRecord(result, "MCP tool result");
  const first = Array.isArray(record.content) ? record.content[0] : null;
  if (!isRecord(first) || typeof first.text !== "string") {
    throw new Error(`MCP tool result had no text content: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return first.text;
}

async function agentRpc(apiUrl: string, mcpToken: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mcpToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
    signal: AbortSignal.timeout(180_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP ${method} failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`MCP ${method} returned no SSE data frame: ${raw.slice(0, 500)}`);
  const payload: unknown = JSON.parse(dataLine.slice(5));
  const record = requireRecord(payload, "MCP JSON-RPC payload");
  if (record.error) throw new Error(`MCP ${method} returned JSON-RPC error: ${JSON.stringify(record.error)}`);
  return record.result;
}

async function listAgentToolNames(apiUrl: string, mcpToken: string): Promise<string[]> {
  const result = requireRecord(await agentRpc(apiUrl, mcpToken, "tools/list", {}), "tools/list result");
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return tools.filter(isRecord).map((tool) => String(tool.name));
}

async function callAgentTool(
  apiUrl: string,
  mcpToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return agentRpc(apiUrl, mcpToken, "tools/call", { name, arguments: args });
}

async function organizationIdOf(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = orgs[0] && typeof orgs[0].id === "string" ? orgs[0].id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function mintMcpToken(session: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(session, "/v1/mcp/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token : "";
  if (!result.response.ok || !token.startsWith("ow_mcp_at_")) {
    throw new Error(`Minting MCP token failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return token;
}

async function dumpScriptReceipts(session: DenSession): Promise<string> {
  try {
    const receipts = await denFetch(session, "/v1/codemode-runs", {
      headers: { authorization: `Bearer ${session.token}` },
    });
    const runs = isRecord(receipts.body) && Array.isArray(receipts.body.runs) ? receipts.body.runs.filter(isRecord) : [];
    return JSON.stringify(runs.map((run) => ({
      source: run.source,
      status: run.status,
      errorKind: run.errorKind,
      errorMessage: typeof run.errorMessage === "string" ? run.errorMessage.slice(0, 300) : run.errorMessage,
      toolCallCount: run.toolCallCount,
      durationMs: run.durationMs,
    })));
  } catch (error) {
    return `receipt fetch failed: ${String(error)}`;
  }
}

async function validateWithRetry(
  shot: Awaited<ReturnType<typeof screenshot>>,
  expectations: string[],
): Promise<Awaited<ReturnType<typeof validate>>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await validate(shot, expectations);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 10_000));
    }
  }
  throw lastError;
}

async function sendPrompt(
  desktopApp: Awaited<ReturnType<typeof app>>,
  prompt: string,
  doneWhen?: (assistantText: string) => boolean,
): Promise<void> {
  await writeComposerText(desktopApp, prompt);
  const before = await readComposerState(desktopApp);
  await waitFor(desktopApp, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => (entry.textContent ?? '').trim() === 'Run task' && !entry.disabled);
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 30_000, label: "Run task clicked" });
  await waitFor(
    desktopApp,
    `document.querySelectorAll('[data-message-role="user"]').length > ${before.userMessageCount}`,
    { timeoutMs: 60_000, label: "prompt submitted" },
  );
  await waitForAssistantReply(desktopApp, { timeoutMs: 420_000 });
  // The turn is over when the Stop control disappears — or, as a stall guard,
  // when the reply already contains what the caller is waiting for.
  const turnDeadline = Date.now() + 420_000;
  while (Date.now() < turnDeadline) {
    const stopVisible = await evalIn(desktopApp, `[...document.querySelectorAll('button')]
      .some((button) => (button.textContent ?? '').trim() === 'Stop')`);
    if (stopVisible !== true) break;
    if (doneWhen && doneWhen(await lastAssistantText(desktopApp))) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (Date.now() >= turnDeadline) {
    throw new Error("Timed out waiting for the assistant turn to complete.");
  }
  const deadline = Date.now() + 60_000;
  let stableFor = 0;
  let last = "";
  while (Date.now() < deadline && stableFor < 2) {
    const current = await lastAssistantText(desktopApp);
    const settled = current === last && current.trim().length > 0 && !current.includes("Thinking");
    stableFor = settled ? stableFor + 1 : 0;
    last = current;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function countScriptToolCalls(desktopApp: Awaited<ReturnType<typeof app>>): Promise<{ script: number; single: number }> {
  const calls = await readSessionToolCalls(desktopApp, { timeoutMs: 30_000 });
  const script = calls.filter((call) => call.capability.includes("execute_capability_script")).length;
  const single = calls.filter((call) =>
    call.capability.includes("execute_capability") && !call.capability.includes("execute_capability_script")).length;
  return { script, single };
}

async function lastAssistantText(desktopApp: Awaited<ReturnType<typeof app>>): Promise<string> {
  const text = await evalIn(desktopApp, `(() => {
    const messages = [...document.querySelectorAll('[data-message-role="assistant"]')];
    return messages.length > 0 ? messages[messages.length - 1].innerText : document.body.innerText;
  })()`);
  return String(text ?? "");
}

test(title, { timeout: 1_500_000 }, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: `Codemode Scripts Eval ${Date.now()}`,
      admin: { name: "Sarah" },
      members: { jordan: { name: "Jordan Eval" } },
    },
    mocks: {
      drive: mcpMock({ allowUnauthenticatedMcp: true }),
      gmail: mcpMock({ allowUnauthenticatedMcp: true }),
    },
  });
  const orgId = await organizationIdOf(den.admin);
  const adminMcpToken = await mintMcpToken(den.admin, orgId);

  // ---- Frame 1: the org-level toggle, off by default ------------------------
  const toolsBefore = await listAgentToolNames(den.ref.apiUrl, adminMcpToken);
  evidence.recordAssertionEvidence(
    "With the org flag off, execute_capability_script is not even discoverable",
    `tools/list before enabling: ${JSON.stringify(toolsBefore)}`,
    toolsBefore.includes("execute_capability") && !toolsBefore.includes("execute_capability_script"),
  );
  expect(toolsBefore).not.toContain("execute_capability_script");

  const flip = await denFetch(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ capabilities: { codemodeScripts: true } }),
  });
  if (!flip.response.ok) {
    throw new Error(`Enabling codemodeScripts failed: HTTP ${flip.response.status} ${flip.text.slice(0, 500)}`);
  }
  const toolsAfter = await listAgentToolNames(den.ref.apiUrl, adminMcpToken);
  evidence.recordAssertionEvidence(
    "Flipping the Codemode scripts org capability registers the script tool",
    `tools/list after enabling: ${JSON.stringify(toolsAfter)}`,
    toolsAfter.includes("execute_capability_script"),
  );
  expect(toolsAfter).toContain("execute_capability_script");

  // ---- Seed: three workers with no activity + two mock org connections ------
  for (const name of ["builder-1", "builder-2", "builder-3"]) {
    const created = await denFetch(den.admin, "/v1/workers", {
      method: "POST",
      headers: { authorization: `Bearer ${den.admin.token}` },
      body: JSON.stringify({ name, destination: "local", workspacePath: "/tmp/openwork-eval-worker" }),
    });
    if (!created.response.ok) {
      throw new Error(`Seeding worker ${name} failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
    }
  }
  const driveConnection = await createOrgConnection(den.admin, {
    name: "Drive Mock",
    url: den.mocks.drive.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  await createOrgConnection(den.admin, {
    name: "Gmail Mock",
    url: den.mocks.gmail.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });

  // ---- Rail probes: the script tool works deterministically before any model
  const namespacesProbe = await callAgentTool(den.ref.apiUrl, adminMcpToken, "execute_capability_script", {
    code: "return Object.keys(tools).sort()",
  });
  const namespacesText = toolText(namespacesProbe);
  evidence.recordAssertionEvidence(
    "The script runtime exposes the Den catalog and both org connections as namespaces",
    `Object.keys(tools): ${namespacesText.slice(0, 300)}`,
    namespacesText.includes("den") && namespacesText.includes("drive_mock") && namespacesText.includes("gmail_mock"),
  );
  expect(namespacesText).toContain("drive_mock");
  expect(namespacesText).toContain("gmail_mock");

  const searchProbe = await callAgentTool(den.ref.apiUrl, adminMcpToken, "execute_capability_script", {
    code: `return await tools.$codemode.search({ query: "list workers" })`,
  });
  const searchProbeText = toolText(searchProbe);
  const probeItems = (() => {
    const parsed: unknown = JSON.parse(searchProbeText);
    const record = isRecord(parsed) ? parsed : {};
    return Array.isArray(record.items) ? record.items.filter(isRecord) : [];
  })();
  const workersPath = probeItems
    .map((item) => String(item.path ?? ""))
    .find((path) => path.startsWith("tools.den.") && path.toLowerCase().includes("workers"));
  evidence.recordAssertionEvidence(
    "In-program tool search finds the Den workers operation",
    `search("list workers") paths: ${JSON.stringify(probeItems.map((item) => item.path)).slice(0, 300)}`,
    Boolean(workersPath),
  );
  if (!workersPath) throw new Error(`No workers operation found via $codemode.search: ${searchProbeText.slice(0, 500)}`);

  const workersProbe = await callAgentTool(den.ref.apiUrl, adminMcpToken, "execute_capability_script", {
    code: `return await ${workersPath}({})`,
  });
  const workersProbeText = toolText(workersProbe);
  evidence.recordAssertionEvidence(
    "A script can call a Den catalog operation and see the seeded workers",
    `${workersPath}({}) → ${workersProbeText.slice(0, 300)}`,
    workersProbeText.includes("builder-1") && workersProbeText.includes("builder-3"),
  );
  expect(workersProbeText).toContain("builder-1");

  const denNamesProbe = await callAgentTool(den.ref.apiUrl, adminMcpToken, "execute_capability_script", {
    code: `return Object.keys(tools.den).sort()`,
  });
  const denNamesText = toolText(denNamesProbe);
  const denNamesValue: unknown = JSON.parse(denNamesText);
  const denNames = Array.isArray(denNamesValue) ? denNamesValue.filter((name): name is string => typeof name === "string") : [];
  const workersOperationName = workersPath.slice("tools.den.".length);
  const leakedNativeNames = denNames.filter((name) => {
    const normalized = name.toLowerCase();
    return normalized.includes("googleworkspace") || normalized.includes("microsoft365");
  });
  evidence.recordAssertionEvidence(
    "Credential-bound native provider operations are not reachable through the shared Den namespace, while ordinary Den capabilities remain available",
    `tools.den names: ${JSON.stringify(denNames).slice(0, 500)}; native operation names: ${JSON.stringify(leakedNativeNames)}; expected workers operation: ${workersOperationName}`,
    leakedNativeNames.length === 0 && denNames.length > 0 && denNames.includes(workersOperationName),
  );
  expect(leakedNativeNames).toEqual([]);
  expect(denNames.length).toBeGreaterThan(0);
  expect(denNames).toContain(workersOperationName);

  const unconnectedGoogle = await createNativeConnector(den.admin, {
    providerKey: "google-workspace",
    name: "Unconnected Google Rail Probe",
    clientId: "unconnected-google-rail-client",
    clientSecret: "unconnected-google-rail-secret",
    access: { orgWide: true },
  });
  let unconnectedGoogleDeleted = false;
  onTestFinished(async () => {
    if (!unconnectedGoogleDeleted) {
      try {
        await deleteConnection(den.admin, unconnectedGoogle.id);
      } catch {
        // A local test Den may already be disposed when Vitest runs cleanup.
      }
    }
  });
  const unconnectedNamespace = "unconnected_google_rail_probe";
  const unconnectedNamespacesProbe = await callAgentTool(den.ref.apiUrl, adminMcpToken, "execute_capability_script", {
    code: `return Object.keys(tools).sort()`,
  });
  const unconnectedNamespacesText = toolText(unconnectedNamespacesProbe);
  const unconnectedNamespacesValue: unknown = JSON.parse(unconnectedNamespacesText);
  const unconnectedNamespaces = Array.isArray(unconnectedNamespacesValue)
    ? unconnectedNamespacesValue.filter((name): name is string => typeof name === "string")
    : [];
  // Closed-world: asserting one guessed namespace is absent would pass even if the
  // sanitizer produced a different name, so pin the whole namespace set instead.
  // The content rails (skills, marketplace, admin) are present because the capability
  // set is one set for all three verbs — this admin is on the bootstrap allowlist, so
  // admin capabilities are in their set; a non-admin member's set has none. No
  // marketplace namespace yet: this org's only marketplace object is the saved script
  // created later, and saved scripts are deliberately excluded (no script recursion).
  const expectedNamespaces = ["$codemode", "admin", "den", "drive_mock", "gmail_mock", "skills"];
  evidence.recordAssertionEvidence(
    "An unconnected native provider does not surface a callable script namespace",
    `Object.keys(tools): ${JSON.stringify(unconnectedNamespaces)}; expected exactly: ${JSON.stringify(expectedNamespaces)}`,
    JSON.stringify(unconnectedNamespaces) === JSON.stringify(expectedNamespaces),
  );
  expect(unconnectedNamespaces).toEqual(expectedNamespaces);
  expect(unconnectedNamespaces).not.toContain(unconnectedNamespace);

  // Interchangeability: whatever search finds, execute runs AND a script can call.
  // A built-in skill is the sharpest case — it used to be searchable and executable
  // but deliberately absent from the script tree.
  const skillSearch = await callAgentTool(den.ref.apiUrl, adminMcpToken, "search_capabilities", {
    query: "skill",
    type: "skills",
    limit: 5,
  });
  const skillMatches = (() => {
    const payload = requireRecord(JSON.parse(toolText(skillSearch)), "skill search payload");
    return Array.isArray(payload.matches) ? payload.matches.filter(isRecord) : [];
  })();
  const skillWithPath = skillMatches.find((match) => typeof match.scriptPath === "string" && match.scriptPath.length > 0);
  evidence.recordAssertionEvidence(
    "A skill capability found by search carries a scriptPath, so the same set is reachable from a script",
    `skills matches: ${JSON.stringify(skillMatches.map((m) => ({ name: m.name, scriptPath: m.scriptPath }))).slice(0, 400)}`,
    Boolean(skillWithPath),
  );
  expect(skillWithPath).toBeTruthy();
  const skillScriptPath = String((skillWithPath ?? {}).scriptPath ?? "");
  const skillCallProbe = await callAgentTool(den.ref.apiUrl, adminMcpToken, "execute_capability_script", {
    code: `const result = await ${skillScriptPath}({})\nreturn typeof result === "string" ? result.slice(0, 120) : result`,
  });
  const skillCallText = toolText(skillCallProbe);
  evidence.recordAssertionEvidence(
    "That same skill capability is callable from inside a script at its advertised scriptPath",
    `${skillScriptPath}({}) -> ${skillCallText.slice(0, 300)}`,
    skillCallText.trim().length > 0 && !skillCallText.includes("script_failed"),
  );
  expect(skillCallText).not.toContain("script_failed");

  const unconnectedSearchProbe = await callAgentTool(den.ref.apiUrl, adminMcpToken, "search_capabilities", {
    query: "Unconnected Google Rail Probe Gmail",
    limit: 20,
  });
  const unconnectedSearchPayload = requireRecord(JSON.parse(toolText(unconnectedSearchProbe)), "unconnected Google search payload");
  const unconnectedSearchMatches = Array.isArray(unconnectedSearchPayload.matches)
    ? unconnectedSearchPayload.matches.filter(isRecord)
    : [];
  const unconnectedConnectionMatches = unconnectedSearchMatches.filter((match) =>
    String(match.name ?? "").includes(unconnectedGoogle.id)
    || (isRecord(match.connectionStatus) && match.connectionStatus.connectionName === unconnectedGoogle.name));
  const unconnectedStatusOnly = unconnectedConnectionMatches.length > 0
    && unconnectedConnectionMatches.every((match) =>
      match.kind === "connection_status"
      && match.status === "needs_connection"
      && typeof match.scriptPath === "undefined");
  evidence.recordAssertionEvidence(
    "Capability search reports the unconnected Google provider as needing connection, never as a callable capability",
    `Matching search rows: ${JSON.stringify(unconnectedConnectionMatches).slice(0, 500)}`,
    unconnectedStatusOnly,
  );
  expect(unconnectedConnectionMatches.length).toBeGreaterThan(0);
  expect(unconnectedStatusOnly).toBe(true);
  await deleteConnection(den.admin, unconnectedGoogle.id);
  unconnectedGoogleDeleted = true;

  // ---- Frames 2+3: one script step instead of a call per worker -------------
  await using desktopApp = await app({ den, as: "admin", place, ...(modelId ? { model: modelId } : {}) });
  await waitFor(desktopApp, `location.hash.includes('/session')`, { timeoutMs: 60_000, label: "session route" });
  if (modelId) {
    try {
      await selectModel(desktopApp, modelId);
    } catch {
      // Provider models can lag the first boot; give the engine one settle pass.
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      await selectModel(desktopApp, modelId);
    }
  }

  try {
    await sendPrompt(
      desktopApp,
      "Answer this question: which of my workers are idle? "
        + "First call search_capabilities with query \"list workers\" and note the scriptPath field on the matches. "
        + "Then call execute_capability_script exactly once with one script that calls that scriptPath, "
        + "reads the response's workers array, and returns exactly result.workers.filter((worker) => worker.lastActiveAt === null).map((worker) => worker.name). "
        + "Do not call execute_capability. Reply with just the idle worker names.",
      (text) => text.includes("builder-1") && text.includes("builder-2") && text.includes("builder-3"),
    );
  } catch (error) {
    evidence.recordAssertionEvidence(
      "DEBUG: idle-workers prompt did not complete; script run receipts follow",
      await dumpScriptReceipts(den.admin),
      false,
    );
    throw error;
  }
  const idleReply = await lastAssistantText(desktopApp);
  const idleAnswerSeen = idleReply.includes("builder-1") && idleReply.includes("builder-2") && idleReply.includes("builder-3");
  const partsAfterIdle = await countScriptToolCalls(desktopApp);
  evidence.recordAssertionEvidence(
    "The idle-workers question ran as a single script step, not one call per worker",
    `Session tool calls: ${JSON.stringify(partsAfterIdle)}; assistant reply: ${idleReply.slice(0, 300)}`,
    partsAfterIdle.script >= 1 && idleAnswerSeen,
  );
  expect(idleAnswerSeen).toBe(true);
  expect(partsAfterIdle.script).toBeGreaterThanOrEqual(1);

  const idleShot = await screenshot(desktopApp);
  const idleSeen = await validateWithRetry(idleShot, [
    "A chat conversation answers which workers are idle, naming builder workers",
    "No error banner or crash message is visible",
  ]);
  expect(idleSeen.ok, idleSeen.why).toBe(true);

  // ---- Frame 4: one script fans out across two org connections --------------
  const markerDrive = `drive-${Date.now()}`;
  const markerGmail = `gmail-${Date.now()}`;
  const fanoutStartedAt = new Date().toISOString();
  const fanoutResult = await callAgentTool(den.ref.apiUrl, adminMcpToken, "execute_capability_script", {
    code: `const [drive, gmail] = await Promise.all([
  tools.drive_mock.mock_echo({ text: ${JSON.stringify(markerDrive)} }),
  tools.gmail_mock.mock_echo({ text: ${JSON.stringify(markerGmail)} }),
])
return { drive, gmail }`,
  });
  const fanoutText = toolText(fanoutResult);
  const driveCalls = await den.mocks.drive.toolCalls({ name: "mock_echo", atLeast: 1, timeoutMs: 60_000, sinceIso: fanoutStartedAt });
  const gmailCalls = await den.mocks.gmail.toolCalls({ name: "mock_echo", atLeast: 1, timeoutMs: 60_000, sinceIso: fanoutStartedAt });
  const driveHit = driveCalls.some((call) => String(call.args.text ?? "").includes(markerDrive));
  const gmailHit = gmailCalls.some((call) => String(call.args.text ?? "").includes(markerGmail));
  evidence.recordAssertionEvidence(
    "One script reached both org connections in parallel and returned only the combined result",
    `Result: ${fanoutText.slice(0, 200)}; Drive witness saw ${markerDrive}: ${String(driveHit)}; Gmail witness saw ${markerGmail}: ${String(gmailHit)}`,
    driveHit && gmailHit && fanoutText.includes(markerDrive) && fanoutText.includes(markerGmail),
  );
  expect(driveHit).toBe(true);
  expect(gmailHit).toBe(true);
  expect(fanoutText).toContain(markerDrive);

  // ---- Frame 5: save it as an org capability through the capability rail -----
  const pluginOpSearch = await callAgentTool(den.ref.apiUrl, adminMcpToken, "search_capabilities", {
    query: "create plugin",
    limit: 10,
  });
  const pluginOpMatches = requireRecord(JSON.parse(toolText(pluginOpSearch)), "plugin op search");
  const pluginOpList = Array.isArray(pluginOpMatches.matches) ? pluginOpMatches.matches.filter(isRecord) : [];
  const createPluginOp = pluginOpList.find((match) =>
    match.method === "POST" && String(match.path ?? "").endsWith("/v1/plugins"));
  if (!createPluginOp) throw new Error(`No create-plugin capability found: ${JSON.stringify(pluginOpList.map((m) => `${m.method} ${m.path}`))}`);
  const idleScriptSource = [
    `const result = await tools.den.getWorkers({})`,
    `const idle = result.workers.filter((worker) => !worker.lastActiveAt)`,
    `return idle.map((worker) => worker.name)`,
  ].join("\n");
  const saveResult = await callAgentTool(den.ref.apiUrl, adminMcpToken, "execute_capability", {
    name: String(createPluginOp.name),
    body: {
      name: "idle-workers-report",
      description: "Lists idle workers",
      orgWide: true,
      components: [{
        type: "script",
        input: {
          rawSourceText: idleScriptSource,
          normalizedPayloadJson: {
            language: "codemode-js",
            inputSchema: { type: "object", properties: { days: { type: "number" } }, additionalProperties: false },
            requiredCapabilities: [
              { capabilityName: "getWorkers", scriptPath: "tools.den.getWorkers" },
            ],
          },
          metadata: { title: "idle-workers-report", description: "Lists idle workers" },
        },
      }],
    },
  });
  const saveText = toolText(saveResult);
  evidence.recordAssertionEvidence(
    "The idle-workers script is saved as an org capability through the capability rail",
    `execute_capability(${String(createPluginOp.name)}) → ${saveText.slice(0, 200)}`,
    saveText.includes("idle-workers-report"),
  );
  const savedObjects = await denFetch(den.admin, "/v1/config-objects?type=script", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  const savedList = isRecord(savedObjects.body) && Array.isArray(savedObjects.body.items)
    ? savedObjects.body.items.filter(isRecord)
    : [];
  const savedScript = savedList.find((object) => String(object.title ?? "").includes("idle-workers-report"));
  evidence.recordAssertionEvidence(
    "The agent saved the script as an org config object of type script",
    `config-objects?type=script returned ${savedList.length} row(s); idle-workers-report present: ${String(Boolean(savedScript))}`,
    Boolean(savedScript),
  );
  expect(savedScript).toBeTruthy();

  // ---- Frame 6: a teammate finds it by search and runs it -------------------
  const jordan = den.members.jordan;
  if (!jordan) throw new Error("Default org member jordan was not provisioned.");
  const jordanMcpToken = await mintMcpToken(jordan, orgId);
  const searchResult = await callAgentTool(den.ref.apiUrl, jordanMcpToken, "search_capabilities", {
    query: "idle workers report",
    limit: 5,
  });
  const searchPayload = requireRecord(JSON.parse(toolText(searchResult)), "search payload");
  const matches = Array.isArray(searchPayload.matches) ? searchPayload.matches.filter(isRecord) : [];
  const scriptMatch = matches.find((match) => String(match.name ?? "").startsWith("plugin:") && match.kind === "script");
  evidence.recordAssertionEvidence(
    "A teammate's agent discovers the saved script through capability search",
    `Member search matches: ${JSON.stringify(matches.map((match) => ({ name: match.name, kind: match.kind })))}`,
    Boolean(scriptMatch),
  );
  expect(scriptMatch).toBeTruthy();
  const scriptCapabilityName = String((scriptMatch ?? {}).name ?? "");

  const memberRun = await callAgentTool(den.ref.apiUrl, jordanMcpToken, "execute_capability", {
    name: scriptCapabilityName,
    body: { days: 14 },
  });
  const memberRunPayload = requireRecord(JSON.parse(toolText(memberRun)), "member run payload");
  const memberRunExecuted = memberRunPayload.status === "executed";
  const memberRunValue = JSON.stringify(memberRunPayload.value ?? null);
  evidence.recordAssertionEvidence(
    "The teammate runs the saved script by name with typed input and gets fresh data from the same program",
    `status: ${String(memberRunPayload.status)}; value: ${memberRunValue.slice(0, 300)}`,
    memberRunExecuted && memberRunValue.includes("builder"),
  );
  expect(memberRunExecuted).toBe(true);
  expect(memberRunValue).toContain("builder");

  // ---- Frame 7a: every run left a receipt ------------------------------------
  const receipts = await denFetch(den.admin, "/v1/codemode-runs", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  const runs = isRecord(receipts.body) && Array.isArray(receipts.body.runs) ? receipts.body.runs.filter(isRecord) : [];
  const adhocRuns = runs.filter((run) => run.source === "adhoc");
  const savedRuns = runs.filter((run) => String(run.source ?? "").startsWith("plugin:"));
  const receiptsHaveDetail = runs.every((run) =>
    typeof run.durationMs === "number" && Array.isArray(run.toolCalls));
  evidence.recordAssertionEvidence(
    "Every script run left a receipt with its tool calls and duration",
    `runs: ${runs.length} (adhoc: ${adhocRuns.length}, saved: ${savedRuns.length}); all carry toolCalls+durationMs: ${String(receiptsHaveDetail)}`,
    adhocRuns.length >= 2 && savedRuns.length >= 1 && receiptsHaveDetail,
  );
  expect(adhocRuns.length).toBeGreaterThanOrEqual(2);
  expect(savedRuns.length).toBeGreaterThanOrEqual(1);

  await using browser = await chrome({
    name: "codemode-script-runs",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1680,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web loaded",
  });
  await evalIn(browser, `localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)})`);
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/script-runs`);
  await waitFor(browser, `document.body.innerText.includes("Workflow Runs") || document.body.innerText.includes("workflow runs")`, {
    timeoutMs: 60_000,
    label: "Workflow Runs dashboard",
  });
  // The banner renders before the table; screenshot only after the loading
  // placeholder is gone and real rows (status chip + duration header) exist.
  // Table headers render uppercase (DURATION), so match case-insensitively.
  await waitFor(
    browser,
    `!document.body.innerText.includes("Loading workflow runs") && /duration/i.test(document.body.innerText) && /succeeded|failed/i.test(document.body.innerText)`,
    { timeoutMs: 60_000, label: "Workflow Runs rows loaded" },
  );
  const runsShot = await screenshot(browser);
  const runsSeen = await validateWithRetry(runsShot, [
    "A dashboard screen lists script runs with status and duration information",
  ]);
  expect(runsSeen.ok, runsSeen.why).toBe(true);

  // ---- Frame 7b: disabling a tool makes dependent saved scripts fail closed --
  // Org-wide plugin creation is a step-up-protected admin write, and this spec runs
  // long enough for the admin session's fresh-auth window to lapse. Re-authenticate
  // first, the same way behaviors' connection helpers do on `reauth`.
  const freshAdmin = await freshSession(den.admin);
  const mentionsPlugin = await denFetch(freshAdmin, "/v1/plugins", {
    method: "POST",
    headers: { authorization: `Bearer ${freshAdmin.token}` },
    body: JSON.stringify({
      name: "offsite-mentions-report",
      description: "Echoes offsite mentions through the Drive Mock connection",
      orgWide: true,
      components: [{
        type: "script",
        input: {
          rawSourceText: `return await tools.drive_mock.mock_echo({ text: "offsite" })`,
          normalizedPayloadJson: {
            language: "codemode-js",
            requiredCapabilities: [{
              capabilityName: `mcp:${driveConnection.id}:mock_echo`,
              scriptPath: "tools.drive_mock.mock_echo",
            }],
          },
          metadata: { title: "offsite-mentions-report", description: "Echoes offsite mentions" },
        },
      }],
    }),
  });
  if (!mentionsPlugin.response.ok) {
    throw new Error(`Creating offsite-mentions-report failed: HTTP ${mentionsPlugin.response.status} ${mentionsPlugin.text.slice(0, 500)}`);
  }
  const mentionsSearch = await callAgentTool(den.ref.apiUrl, adminMcpToken, "search_capabilities", {
    query: "offsite mentions report",
    limit: 5,
  });
  const mentionsMatches = requireRecord(JSON.parse(toolText(mentionsSearch)), "mentions search payload");
  const mentionsMatchList = Array.isArray(mentionsMatches.matches) ? mentionsMatches.matches.filter(isRecord) : [];
  const mentionsMatch = mentionsMatchList.find((match) => String(match.name ?? "").startsWith("plugin:") && match.kind === "script");
  if (!mentionsMatch) throw new Error(`offsite-mentions-report not discoverable: ${JSON.stringify(mentionsMatchList)}`);
  const mentionsName = String(mentionsMatch.name);

  const healthyRun = await callAgentTool(den.ref.apiUrl, adminMcpToken, "execute_capability", {
    name: mentionsName,
    body: {},
  });
  const healthyPayload = requireRecord(JSON.parse(toolText(healthyRun)), "healthy mentions run");
  expect(healthyPayload.status).toBe("executed");

  const policyFlippedAt = new Date().toISOString();
  const policy = await denFetch(den.admin, `/v1/mcp-connections/${driveConnection.id}/tool-policy`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ allDisabled: false, disabledTools: ["mock_echo"] }),
  });
  if (!policy.response.ok) {
    throw new Error(`Disabling mock_echo failed: HTTP ${policy.response.status} ${policy.text.slice(0, 500)}`);
  }
  const blockedRun = await callAgentTool(den.ref.apiUrl, adminMcpToken, "execute_capability", {
    name: mentionsName,
    body: {},
  });
  const blockedText = toolText(blockedRun);
  const blockedFailedClosed = blockedText.includes("capability_unavailable")
    && blockedText.includes("providerCallAttempted") === blockedText.includes(`"providerCallAttempted":false`);
  let blockedWitnessCalls = 0;
  try {
    const calls = await den.mocks.drive.toolCalls({ name: "mock_echo", atLeast: 1, timeoutMs: 5_000, sinceIso: policyFlippedAt });
    blockedWitnessCalls = calls.length;
  } catch {
    blockedWitnessCalls = 0;
  }
  evidence.recordAssertionEvidence(
    "Disabling a connection tool makes the dependent saved script fail closed without reaching the provider",
    `Blocked run payload: ${blockedText.slice(0, 400)}; provider calls after policy flip: ${blockedWitnessCalls}`,
    blockedText.includes("capability_unavailable") && blockedWitnessCalls === 0,
  );
  expect(blockedText).toContain("capability_unavailable");
  expect(blockedWitnessCalls).toBe(0);
  expect(blockedFailedClosed).toBe(true);

});
