import { expect } from "vitest";
import {
  createOrgConnection,
  denFetch,
  evalIn,
  waitFor,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { closeTarget, listTargets, navigate } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { chrome } from "@openwork/hosts";
import { mcpMock, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `tool tester page skipped — needs: ${missingRequirements.join(", ")}`
  : "an admin can test and govern an MCP tool from the dedicated Tool Tester page";

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

function toolJson(result: unknown): unknown {
  return JSON.parse(toolText(result));
}

function searchMatches(result: unknown): Record<string, unknown>[] {
  const payload = requireRecord(toolJson(result), "search_capabilities payload");
  return Array.isArray(payload.matches) ? payload.matches.filter(isRecord) : [];
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const id = organizations[0] && typeof organizations[0].id === "string" ? organizations[0].id : "";
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
    body: JSON.stringify({}),
  });
  const token = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token : "";
  if (!result.response.ok || !token.startsWith("ow_mcp_at_")) {
    throw new Error(`Minting MCP token failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return token;
}

async function callTool(
  apiUrl: string,
  mcpToken: string,
  name: "search_capabilities" | "execute_capability",
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mcpToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP tools/call failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`MCP tools/call returned no SSE data frame: ${raw.slice(0, 500)}`);
  const payload: unknown = JSON.parse(dataLine.slice(5));
  const record = requireRecord(payload, "MCP JSON-RPC payload");
  if (record.error) throw new Error(`MCP tools/call returned JSON-RPC error: ${JSON.stringify(record.error)}`);
  return record.result;
}

async function replaceInputText(surface: Surface, selector: string, value: string): Promise<void> {
  await waitFor(surface, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, {
    timeoutMs: 30_000,
    label: `input ${selector}`,
  });
  const focused = await evalIn(surface, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) return false;
    input.focus();
    input.select();
    return document.activeElement === input;
  })()`);
  expect(focused).toBe(true);
  if (value) {
    await surface.client.send("Input.insertText", { text: value });
  } else {
    await surface.client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    await surface.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
  }
  await evalIn(surface, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) return false;
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const props = reactPropsKey ? input[reactPropsKey] : null;
    const handler = props?.onInput ?? props?.onChange;
    if (typeof handler === "function") handler({ target: input, currentTarget: input });
    return typeof handler === "function";
  })()`);
  await waitFor(surface, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`, {
    timeoutMs: 10_000,
    label: `input ${selector} value ${JSON.stringify(value)}`,
  });
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: `Tool Tester Eval ${Date.now()}`,
      admin: { name: "Sarah" },
    },
    mocks: { connector: mcpMock() },
  });
  const connector = den.mocks.connector;
  const connection = await createOrgConnection(den.admin, {
    name: `Tool Tester Probe ${Date.now()}`,
    url: connector.mcpUrl,
    authType: "oauth",
    credentialMode: "shared",
    access: { orgWide: true },
  });

  await using browser = await chrome({
    name: "tool-tester-page",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before admin auth token handoff",
  });
  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(den.admin.token)};
  })()`);
  expect(tokenStored).toBe(true);

  await navigate(browser.client, `${den.ref.webUrl}/dashboard/your-connections`);
  await waitFor(browser, `document.body.innerText.includes("Your Connections")
    && document.body.innerText.includes(${JSON.stringify(connection.name)})`, {
    timeoutMs: 60_000,
    label: "Tool Tester Probe row on Your Connections",
  });
  const connectStartedAt = new Date().toISOString();
  await waitFor(browser, `(() => {
    const name = [...document.querySelectorAll("p")]
      .find((entry) => (entry.textContent ?? "").trim() === ${JSON.stringify(connection.name)});
    let row = name?.parentElement ?? null;
    while (row && ![...row.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === "Connect")) {
      row = row.parentElement;
    }
    const connect = row ? [...row.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim() === "Connect" && !button.disabled) : null;
    connect?.click();
    return Boolean(connect);
  })()`, { timeoutMs: 30_000, label: "Connect the Tool Tester Probe org account" });
  await connector.authorizeRequestSince(connectStartedAt, { timeoutMs: 120_000 });

  const wrenchTestId = `toggle-mcp-tool-runner-${connection.id}`;
  await waitFor(browser, `(() => {
    const link = document.querySelector(${JSON.stringify(`[data-testid="${wrenchTestId}"]`)});
    return link instanceof HTMLAnchorElement
      && link.getAttribute("href")?.includes("/dashboard/tool-tester?connectionId=");
  })()`, { timeoutMs: 120_000, label: "dedicated Tool Tester wrench link" });
  const wrenchHref = await evalIn(browser, `document.querySelector(${JSON.stringify(`[data-testid="${wrenchTestId}"]`)})?.getAttribute("href") ?? ""`);
  expect(typeof wrenchHref).toBe("string");
  expect(String(wrenchHref)).toContain(`/dashboard/tool-tester?connectionId=${encodeURIComponent(connection.id)}`);
  evidence.recordAssertionEvidence(
    "Your Connections exposes the connected MCP's dedicated Tool Tester link",
    `Observed wrench href: ${String(wrenchHref)}`,
    typeof wrenchHref === "string" && wrenchHref.includes("/dashboard/tool-tester?connectionId="),
  );

  const oauthTargets = (await listTargets(browser.handle.cdpUrl))
    .filter((target) => target.type === "page" && !target.url.startsWith(den.ref.webUrl));
  for (const target of oauthTargets) await closeTarget(browser.handle.cdpUrl, target.id);

  const wrenchClicked = await evalIn(browser, `(() => {
    const link = document.querySelector(${JSON.stringify(`[data-testid="${wrenchTestId}"]`)});
    if (!(link instanceof HTMLAnchorElement)) return false;
    link.click();
    return true;
  })()`);
  expect(wrenchClicked).toBe(true);
  const toolTesterUrl = `${den.ref.webUrl}/dashboard/tool-tester?connectionId=${encodeURIComponent(connection.id)}`;
  await navigate(browser.client, toolTesterUrl);
  await waitFor(browser, `location.origin === ${JSON.stringify(den.ref.webUrl)} && document.readyState === "complete"`, {
    timeoutMs: 30_000,
    label: "Den Web origin after the OAuth popup completed",
  });
  await evalIn(browser, `localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)})`);
  await navigate(browser.client, toolTesterUrl);
  await waitFor(browser, `location.pathname === "/dashboard/tool-tester"
    && new URLSearchParams(location.search).get("connectionId") === ${JSON.stringify(connection.id)}
    && document.body.innerText.includes("Tool Tester")
    && Boolean(document.querySelector('[aria-label="Search tools"]'))`, {
    timeoutMs: 60_000,
    label: "dedicated Tool Tester page and searchable tool rail",
  });

  await replaceInputText(browser, '[aria-label="Search tools"]', "echo");
  await waitFor(browser, `document.querySelector('[aria-label="Search tools"]')?.value === "echo"
    && document.body.innerText.includes("mock_echo")`, {
    timeoutMs: 30_000,
    label: "tool search accepted echo and kept mock_echo available",
  });
  await waitFor(browser, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").includes("mock_echo") && !entry.matches('[role="switch"]'));
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 30_000, label: "selected mock_echo from the tool rail" });
  await waitFor(browser, `(() => {
    const editor = document.querySelector('[role="radiogroup"][aria-label="Arguments editor mode"]');
    const form = editor ? [...editor.querySelectorAll('[role="radio"]')]
      .find((entry) => (entry.textContent ?? "").trim() === "Form") : null;
    const json = editor ? [...editor.querySelectorAll('[role="radio"]')]
      .find((entry) => (entry.textContent ?? "").trim() === "JSON") : null;
    const label = document.querySelector('label[for="tool-argument-text"]');
    return form?.getAttribute("aria-checked") === "true"
      && json?.getAttribute("aria-checked") === "false"
      && (label?.textContent ?? "").includes("text")
      && Boolean(document.querySelector('#tool-argument-text'));
  })()`, { timeoutMs: 30_000, label: "mock_echo Form editor with text field" });
  evidence.recordAssertionEvidence(
    "The searchable rail selects mock_echo and renders its schema as a Form text field",
    "Search accepted 'echo'; Form was active and tool-argument-text rendered.",
    true,
  );

  const marker = `tool-tester-${Date.now()}`;
  await replaceInputText(browser, "#tool-argument-text", marker);
  const runStartedAt = new Date().toISOString();
  await waitFor(browser, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").trim() === "Run tool" && !entry.disabled);
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 30_000, label: "run mock_echo" });
  await waitFor(browser, `(() => {
    const inspector = document.querySelector('[aria-label="Tool call inspection"]');
    if (!inspector) return false;
    const tabs = [...inspector.querySelectorAll('[role="tab"]')];
    return (inspector.textContent ?? "").includes("Tool completed")
      && (inspector.textContent ?? "").includes("OpenWork")
      && (inspector.textContent ?? "").includes("HTTP 200")
      && (inspector.textContent ?? "").includes("Tool result")
      && (inspector.textContent ?? "").includes(${JSON.stringify(marker)})
      && ["Result", "Request", "Response"].every((label) => tabs.some((tab) => (tab.textContent ?? "").trim() === label))
      && tabs.some((tab) => (tab.textContent ?? "").trim() === "Result" && tab.getAttribute("aria-selected") === "true");
  })()`, { timeoutMs: 120_000, label: "successful trace pipeline, result, request, and response tabs" });

  const calls = await connector.toolCalls({ name: "mock_echo", atLeast: 1, timeoutMs: 120_000, sinceIso: runStartedAt });
  const markerReachedConnector = calls.some((call) => call.args.text === marker);
  const unexpectedBatchCalls = await connector.toolCalls({ name: "mock_batch", sinceIso: runStartedAt });
  evidence.recordAssertionEvidence(
    "The Tool Tester sent the exact Form marker to mock_echo",
    `Served mock_echo calls: ${JSON.stringify(calls)}`,
    markerReachedConnector,
  );
  evidence.recordAssertionEvidence(
    "Running mock_echo did not invoke mock_batch",
    `mock_batch calls since the run began: ${JSON.stringify(unexpectedBatchCalls)}`,
    unexpectedBatchCalls.length === 0,
  );
  expect(markerReachedConnector).toBe(true);
  expect(unexpectedBatchCalls).toHaveLength(0);

  const sessionOnlyCaption = await evalIn(
    browser,
    `document.body.innerText.includes("Kept in this browser for this session only — OpenWork never stores run results.")`,
  );
  const orgKillSwitchPresent = await evalIn(browser, `(() => {
    const toggle = document.querySelector('[role="switch"][aria-label="Tools enabled for your organization"]');
    return toggle?.getAttribute("aria-checked") === "true";
  })()`);
  expect(sessionOnlyCaption).toBe(true);
  expect(orgKillSwitchPresent).toBe(true);
  evidence.recordAssertionEvidence(
    "The page exposes the organization kill switch and session-only run-history notice",
    "The org toggle was enabled and the Recent runs caption said OpenWork never stores run results.",
    sessionOnlyCaption === true && orgKillSwitchPresent === true,
  );
  await evalIn(browser, `(() => {
    const inspector = document.querySelector('[aria-label="Tool call inspection"]');
    inspector?.scrollIntoView({ block: "center" });
    return Boolean(inspector);
  })()`);
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The dedicated Tool Tester page shows a completed mock_echo run",
      "A clear trace reads OpenWork, HTTP 200, and Tool result",
      "The result is visible with Result, Request, and Response tabs available",
      "No error banner or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  await replaceInputText(browser, '[aria-label="Search tools"]', "batch");
  await waitFor(browser, `document.querySelector('[aria-label="Search tools"]')?.value === "batch"
    && document.body.innerText.includes("mock_batch")`, {
    timeoutMs: 30_000,
    label: "tool search accepted batch and kept mock_batch available",
  });
  await waitFor(browser, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").includes("mock_batch") && !entry.matches('[role="switch"]'));
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 30_000, label: "selected mock_batch from the tool rail" });
  await waitFor(browser, `(() => {
    const editor = document.querySelector('[role="radiogroup"][aria-label="Arguments editor mode"]');
    const form = editor ? [...editor.querySelectorAll('[role="radio"]')]
      .find((entry) => (entry.textContent ?? "").trim() === "Form") : null;
    const json = editor ? [...editor.querySelectorAll('[role="radio"]')]
      .find((entry) => (entry.textContent ?? "").trim() === "JSON") : null;
    return form?.hasAttribute("disabled")
      && json?.getAttribute("aria-checked") === "true"
      && Boolean(document.querySelector("textarea"))
      && document.body.innerText.includes("This tool's schema can't be shown as a form — edit the JSON directly.");
  })()`, { timeoutMs: 30_000, label: "mock_batch forced JSON editor fallback" });
  evidence.recordAssertionEvidence(
    "The nested mock_batch schema falls back to JSON without breaking the editor",
    "JSON was selected, Form was disabled, a textarea rendered, and the fallback caption was visible.",
    true,
  );

  const orgId = await organizationId(den.admin);
  const mcpToken = await mintMcpToken(den.admin, orgId);
  const capabilityName = `mcp:${connection.id}:mock_echo`;
  const beforeSearch = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: "mock echo",
    limit: 20,
  });
  const beforeMatch = searchMatches(beforeSearch).find((entry) => entry.name === capabilityName);
  expect(beforeMatch).toBeDefined();
  const schemaDigest = beforeMatch && typeof beforeMatch.schemaDigest === "string" ? beforeMatch.schemaDigest : "";
  expect(schemaDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  evidence.recordAssertionEvidence(
    "An agent can discover mock_echo while the organization policy enables it",
    `search_capabilities matches: ${JSON.stringify(searchMatches(beforeSearch))}`,
    Boolean(beforeMatch),
  );

  await replaceInputText(browser, '[aria-label="Search tools"]', "");
  const echoPolicyTestId = "tool-policy-switch-mock_echo";
  await waitFor(browser, `(() => {
    const toggle = document.querySelector(${JSON.stringify(`[data-testid="${echoPolicyTestId}"]`)});
    if (!(toggle instanceof HTMLButtonElement) || toggle.disabled || toggle.getAttribute("aria-checked") !== "true") return false;
    toggle.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "disable mock_echo for the organization" });
  await waitFor(browser, `(() => {
    const toggle = document.querySelector(${JSON.stringify(`[data-testid="${echoPolicyTestId}"]`)});
    const row = toggle?.parentElement?.parentElement;
    return toggle?.getAttribute("aria-checked") === "false"
      && (row?.innerText ?? "").includes("Disabled by Sarah");
  })()`, { timeoutMs: 60_000, label: "mock_echo disabled with Sarah audit attribution" });
  const selectedDisabledEcho = await evalIn(browser, `(() => {
    const toggle = document.querySelector(${JSON.stringify(`[data-testid="${echoPolicyTestId}"]`)});
    const row = toggle?.parentElement?.parentElement;
    const select = row ? [...row.querySelectorAll("button")].find((button) => button !== toggle) : null;
    select?.click();
    return Boolean(select);
  })()`);
  expect(selectedDisabledEcho).toBe(true);
  await waitFor(browser, `document.body.innerText.includes("Disabled for your organization by Sarah")
    && [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === "Run tool" && button.disabled)`, {
    timeoutMs: 30_000,
    label: "selected disabled tool notice and disabled Run tool action",
  });
  evidence.recordAssertionEvidence(
    "Sarah's policy change disables mock_echo for the whole organization",
    "The switch turned off, the rail said Disabled by Sarah, and the selected tool's Run tool action was disabled.",
    true,
  );

  const afterSearch = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: "mock echo",
    limit: 20,
  });
  const afterMatches = searchMatches(afterSearch);
  const capabilityHidden = !afterMatches.some((entry) => entry.name === capabilityName);
  evidence.recordAssertionEvidence(
    "Disabled mock_echo is omitted from agent search_capabilities results",
    `Matches after disable: ${JSON.stringify(afterMatches)}`,
    capabilityHidden,
  );
  expect(capabilityHidden).toBe(true);

  const blockedStartedAt = new Date().toISOString();
  const blockedExecution = requireRecord(await callTool(den.ref.apiUrl, mcpToken, "execute_capability", {
    name: capabilityName,
    schemaDigest,
    body: { text: `blocked-${marker}` },
  }), "blocked execute_capability result");
  const blockedPayload = requireRecord(toolJson(blockedExecution), "blocked execute_capability payload");
  const connectorCallsAfterBlock = await connector.toolCalls({ name: "mock_echo", sinceIso: blockedStartedAt });
  const policyBlocked = blockedExecution.isError === true && blockedPayload.error === "policy_blocked";
  evidence.recordAssertionEvidence(
    "Direct agent execution of disabled mock_echo returns policy_blocked",
    `execute_capability payload: ${JSON.stringify(blockedPayload)}`,
    policyBlocked,
  );
  evidence.recordAssertionEvidence(
    "The policy-blocked agent attempt never reached the MCP connector",
    `mock_echo connector calls since blocked execute: ${JSON.stringify(connectorCallsAfterBlock)}`,
    connectorCallsAfterBlock.length === 0,
  );
  expect(policyBlocked).toBe(true);
  expect(connectorCallsAfterBlock).toHaveLength(0);

  await evalIn(browser, `(() => {
    const notice = [...document.querySelectorAll("p, div")]
      .find((entry) => (entry.textContent ?? "").includes("Disabled for your organization by Sarah"));
    notice?.scrollIntoView({ block: "center" });
    return Boolean(notice);
  })()`);
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The Tool Tester shows mock_echo disabled for the organization",
      "The disabled state visibly attributes the policy change to Sarah",
      "Run tool is disabled and an Enable tool action is available",
      "No generic error or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
});
