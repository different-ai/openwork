import { expect } from "vitest";
import { evalIn, waitFor } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
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
  ? `connectors quick add skipped — needs: ${missingRequirements.join(", ")}`
  : "an admin can find, resolve, and add a connector from the unified quick-add bar";

const smartBarSelector = '[data-testid="connector-smart-bar"]';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function replaceSmartBarText(browser: Surface, value: string): Promise<void> {
  await waitFor(browser, `Boolean(document.querySelector(${JSON.stringify(smartBarSelector)}))`, {
    timeoutMs: 30_000,
    label: "connector smart bar input",
  });
  const replaced = await evalIn(browser, `(() => {
    const input = document.querySelector(${JSON.stringify(smartBarSelector)});
    if (!(input instanceof HTMLInputElement)) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return null;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  })()`);
  expect(replaced).toBe(value);
  await waitFor(browser, `document.querySelector(${JSON.stringify(smartBarSelector)})?.value === ${JSON.stringify(value)}`, {
    timeoutMs: 10_000,
    label: `connector smart bar value ${JSON.stringify(value)}`,
  });
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: `Connectors Quick Add Eval ${Date.now()}`,
      admin: { name: "Sarah" },
    },
    mocks: { connector: mcpMock() },
  });
  const connector = den.mocks.connector;

  await using browser = await chrome({
    name: "connectors-quick-add",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1200,
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

  await navigate(browser.client, `${den.ref.webUrl}/dashboard/mcp-connections`);
  await waitFor(browser, `(() => {
    const groupHeaders = [...document.querySelectorAll("h4")].map((entry) => (entry.textContent ?? "").trim());
    return location.pathname === "/dashboard/mcp-connections"
      && Boolean(document.querySelector('[data-testid="connector-smart-bar"]'))
      && Boolean(document.querySelector('[data-testid="connector-quick-add-grid"]'))
      && groupHeaders.includes("From your workspace suite")
      && groupHeaders.includes("MCP servers")
      && document.querySelectorAll('[data-testid^="quick-add-preset-"]').length === 10
      && (document.querySelector('[data-testid="quick-add-preset-slack"]')?.textContent ?? "").includes("OAuth app required")
      && (document.querySelector('[data-testid="quick-add-preset-exa"]')?.textContent ?? "").includes("API key")
      && (document.querySelector('[data-testid="quick-add-preset-context7"]')?.textContent ?? "").includes("Instant")
      && (document.querySelector('[data-testid="quick-add-preset-notion"]')?.textContent ?? "").includes("One-click");
  })()`, {
    timeoutMs: 60_000,
    label: "full connectors quick-add bar, groups, and preset effort badges",
  });

  const smartBarPresent = await evalIn(browser, `Boolean(document.querySelector('[data-testid="connector-smart-bar"]'))`);
  const standaloneAddMcpMissing = await evalIn(browser, `![...document.querySelectorAll("button, a")]
    .some((entry) => (entry.textContent ?? "").trim() === "Add MCP")`);
  expect(smartBarPresent).toBe(true);
  expect(standaloneAddMcpMissing).toBe(true);
  evidence.recordAssertionEvidence(
    "Connectors opens with one smart search-or-paste bar and no standalone Add MCP action",
    `Smart bar present: ${String(smartBarPresent)}; standalone Add MCP absent: ${String(standaloneAddMcpMissing)}.`,
    smartBarPresent === true && standaloneAddMcpMissing === true,
  );

  const fullPresetCount = await evalIn(browser, `document.querySelectorAll('[data-testid^="quick-add-preset-"]').length`);
  const bothGroupHeaders = await evalIn(browser, `(() => {
    const headers = [...document.querySelectorAll("h4")].map((entry) => (entry.textContent ?? "").trim());
    return headers.includes("From your workspace suite") && headers.includes("MCP servers");
  })()`);
  expect(fullPresetCount).toBe(10);
  expect(bothGroupHeaders).toBe(true);
  evidence.recordAssertionEvidence(
    "Quick add separates the workspace suite from all ten MCP server presets",
    `Both group headers present: ${String(bothGroupHeaders)}; MCP preset tiles: ${String(fullPresetCount)}.`,
    bothGroupHeaders === true && fullPresetCount === 10,
  );

  const effortBadgesMatch = await evalIn(browser, `(() => {
    const text = (testId) => document.querySelector('[data-testid="' + testId + '"]')?.textContent ?? "";
    return text("quick-add-preset-slack").includes("OAuth app required")
      && text("quick-add-preset-exa").includes("API key")
      && text("quick-add-preset-context7").includes("Instant")
      && text("quick-add-preset-notion").includes("One-click");
  })()`);
  expect(effortBadgesMatch).toBe(true);
  evidence.recordAssertionEvidence(
    "Preset tiles disclose OAuth-app, API-key, instant, and one-click setup effort",
    "Slack showed OAuth app required; Exa showed API key; Context7 showed Instant; Notion showed One-click.",
    effortBadgesMatch === true,
  );
  // Context7's Instant mechanism is covered without clicking it here: doing so
  // would contact the real mcp.context7.com rather than this spec's witness.

  await sleep(500);
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The Connectors page shows one smart search-or-paste bar above grouped quick-add tiles",
      "Workspace suite and MCP server group headings are visible",
      "Setup-effort pills including OAuth app required, API key, One-click, and Instant are readable on tiles",
      "No standalone Add MCP button or error banner is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  await replaceSmartBarText(browser, "sla");
  await waitFor(browser, `(() => {
    const presets = document.querySelectorAll('[data-testid^="quick-add-preset-"]');
    return presets.length === 1
      && Boolean(document.querySelector('[data-testid="quick-add-preset-slack"]'))
      && !document.querySelector('[data-testid="quick-add-preset-notion"]');
  })()`, {
    timeoutMs: 20_000,
    label: "live Slack-only quick-add filter with Notion absent",
  });
  const slackOnly = await evalIn(browser, `document.querySelectorAll('[data-testid^="quick-add-preset-"]').length === 1
    && Boolean(document.querySelector('[data-testid="quick-add-preset-slack"]'))`);
  const notionAbsent = await evalIn(browser, `!document.querySelector('[data-testid="quick-add-preset-notion"]')`);
  expect(slackOnly).toBe(true);
  expect(notionAbsent).toBe(true);
  evidence.recordAssertionEvidence(
    "Typing sla narrows the live grid to Slack and removes Notion",
    `Slack was the only preset tile: ${String(slackOnly)}; Notion absent: ${String(notionAbsent)}.`,
    slackOnly === true && notionAbsent === true,
  );

  await replaceSmartBarText(browser, "");
  await waitFor(browser, `document.querySelectorAll('[data-testid^="quick-add-preset-"]').length === 10`, {
    timeoutMs: 20_000,
    label: "full preset grid after clearing the smart bar",
  });

  const witnessStartedAt = new Date().toISOString();
  await replaceSmartBarText(browser, connector.mcpUrl);
  await waitFor(browser, `(() => {
    const card = document.querySelector('[data-testid="smart-bar-result-card"]');
    const submit = document.querySelector('[data-testid="smart-bar-submit"]');
    const text = card?.textContent ?? "";
    return Boolean(card)
      && text.includes("OAuth sign-in")
      && text.includes("Ready to add")
      && text.includes("Options")
      && text.includes("Add connection")
      && submit instanceof HTMLButtonElement
      && !submit.disabled;
  })()`, {
    timeoutMs: 60_000,
    label: "inline ready-to-add result for the mock MCP URL",
  });
  const inlineReady = await evalIn(browser, `(() => {
    const card = document.querySelector('[data-testid="smart-bar-result-card"]');
    const submit = document.querySelector('[data-testid="smart-bar-submit"]');
    return (card?.textContent ?? "").includes("Ready to add")
      && submit instanceof HTMLButtonElement
      && !submit.disabled;
  })()`);
  expect(inlineReady).toBe(true);
  evidence.recordAssertionEvidence(
    "The pasted mock MCP URL resolves inline as ready to add",
    "The result card showed OAuth sign-in, Ready to add, Options, and an enabled Add connection action.",
    inlineReady === true,
  );

  await sleep(500);
  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "An inline card directly below the smart bar shows the resolved mock MCP server",
      "The card shows OAuth sign-in and Ready to add pills with Options and Add connection actions",
      "The quick-add tiles remain visible below the inline result instead of being replaced by a modal",
      "No error banner or modal covers the page",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const submitted = await evalIn(browser, `(() => {
    const button = document.querySelector('[data-testid="smart-bar-submit"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(submitted).toBe(true);
  await waitFor(browser, `(() => {
    const row = [...document.querySelectorAll('[data-testid^="mcp-connection-row-"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connector.mcpUrl)}));
    const notice = [...document.querySelectorAll('[role="status"]')]
      .find((entry) => (entry.textContent ?? "").includes("added for everyone"));
    return Boolean(row && notice)
      && document.querySelectorAll('[data-testid^="quick-add-preset-"]').length === 10;
  })()`, {
    timeoutMs: 60_000,
    label: "created mock connection row, success notice, and restored ten-preset grid",
  });

  const createdRowTestId = await evalIn(browser, `([...document.querySelectorAll('[data-testid^="mcp-connection-row-"]')]
    .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connector.mcpUrl)})))
    ?.getAttribute("data-testid") ?? ""`);
  const restoredPresetCount = await evalIn(browser, `document.querySelectorAll('[data-testid^="quick-add-preset-"]').length`);
  expect(typeof createdRowTestId).toBe("string");
  expect(createdRowTestId).toMatch(/^mcp-connection-row-/);
  expect(restoredPresetCount).toBe(10);
  // This mock connection uses a custom URL, so no curated tile should flip to
  // Added. The Added/Manage tile mechanism has focused Bun coverage; this app
  // spec scopes frame 6 to the real row plus the unaffected ten-preset grid.
  evidence.recordAssertionEvidence(
    "Add connection creates a row in Your connectors without disturbing the preset grid",
    `Created row test id: ${String(createdRowTestId)}; remaining preset tiles: ${String(restoredPresetCount)}.`,
    typeof createdRowTestId === "string"
      && createdRowTestId.startsWith("mcp-connection-row-")
      && restoredPresetCount === 10,
  );

  const handshakes = await connector.handshakes({
    sinceIso: witnessStartedAt,
    atLeast: 1,
    timeoutMs: 60_000,
  });
  const requests = await connector.requests();
  const discoveryRequests = requests.filter((request) => (
    request.at >= witnessStartedAt
    && request.method === "POST"
    && request.path === "/mcp"
  ));
  const toolCalls = await connector.toolCalls({ sinceIso: witnessStartedAt });
  expect(handshakes.length).toBeGreaterThanOrEqual(1);
  expect(discoveryRequests.length).toBeGreaterThanOrEqual(1);
  expect(toolCalls).toHaveLength(0);
  evidence.recordAssertionEvidence(
    "Smart-bar resolution reached the mock connector for MCP discovery",
    `Initialize handshakes: ${handshakes.length}; POST /mcp requests: ${discoveryRequests.length}.`,
    handshakes.length >= 1 && discoveryRequests.length >= 1,
  );
  evidence.recordAssertionEvidence(
    "Quick add did not execute any connector tool",
    `MCP tools/call requests since URL resolution began: ${JSON.stringify(toolCalls)}.`,
    toolCalls.length === 0,
  );
});
