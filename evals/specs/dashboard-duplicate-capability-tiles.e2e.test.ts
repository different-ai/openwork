import { expect } from "vitest";
import { createOrgConnection, denFetch, evalIn, signInInBrowser, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { screenshot } from "@openwork/test-evidence";
import { eventually, mcpMock, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `duplicate-capability dashboard tiles skipped — needs: ${missingRequirements.join(", ")}`
  : "an organization dashboard holds two tiles of the same MCP App capability with different launch arguments";

// Customer report (2026-09-02): a dashboard cannot hold two tiles that call the
// same MCP tool (e.g. two JQL queries). This spec drives the real Den Web
// authoring picker against a witness MCP that exposes exactly ONE App-visible
// launch tool, adds it once, then asserts the picker still offers it so a
// second tile with different launch input can be added and both persist.
const appToolName = "search_issues_using_jql";
const appToolTitle = "Search issues (JQL)";
const firstArguments = { jql: "project = ALPHA ORDER BY created DESC" };
const secondArguments = { jql: "project = BETA AND status = Open" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

type PersistedElement = {
  toolName: string;
  jql: string | null;
};

async function readDashboardElements(session: DenSession, dashboardId: string): Promise<PersistedElement[]> {
  const result = await denFetch(session, `/v1/dashboards/${dashboardId}`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!result.response.ok) {
    throw new Error(`Reading the dashboard failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  const item = isRecord(result.body) && isRecord(result.body.item) ? result.body.item : null;
  return records(item?.elements).map((element) => {
    const launchArguments = isRecord(element.launchArguments) ? element.launchArguments : {};
    return {
      toolName: typeof element.toolName === "string" ? element.toolName : "",
      jql: typeof launchArguments.jql === "string" ? launchArguments.jql : null,
    };
  });
}

test(title, { timeout: 420_000 }, async ({ evidence, place }) => {
  needs(requirements);
  const stamp = Date.now();

  await using den = await server({
    place,
    env: { DEN_DASHBOARDS_ENABLED: "true" },
    org: {
      name: `Duplicate tile org ${stamp}`,
      admin: { name: "Duplicate Tile Admin" },
    },
    mocks: {
      tracker: mcpMock({ allowUnauthenticatedMcp: true, appToolName }),
    },
  });

  const connection = await createOrgConnection(den.admin, {
    name: `Issue tracker ${stamp}`,
    url: den.mocks.tracker.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });

  // Witness sanity: the connection exposes exactly ONE App-visible launch tool,
  // so any second tile can only come from re-adding the same capability.
  const catalog = await denFetch(den.admin, `/v1/mcp-connections/${connection.id}/mcp-apps`, {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  const catalogApps = isRecord(catalog.body) ? records(catalog.body.apps) : [];
  expect(catalog.response.status, catalog.text).toBe(200);
  expect(catalogApps).toHaveLength(1);
  expect(catalogApps[0]).toMatchObject({ toolName: appToolName, requiresInput: true });
  evidence.recordAssertionEvidence(
    "The witness connection exposes exactly one MCP App launch tool",
    `GET /v1/mcp-connections/${connection.id}/mcp-apps returned ${catalogApps.length} app(s): ${JSON.stringify(catalogApps.map((app) => app.toolName))}`,
    catalogApps.length === 1 && catalogApps[0].toolName === appToolName,
  );

  const dashboardName = `JQL board ${stamp}`;
  const created = await denFetch(den.admin, "/v1/dashboards", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ name: dashboardName, elements: [] }),
  });
  const createdItem = isRecord(created.body) && isRecord(created.body.item) ? created.body.item : null;
  const dashboardId = createdItem && typeof createdItem.id === "string" ? createdItem.id : "";
  if (created.response.status !== 201 || !dashboardId) {
    throw new Error(`Creating the dashboard failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }

  await using browser = await chrome({
    name: "dashboard-duplicate-capability-tiles",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before token handoff",
  });
  await signInInBrowser(browser, den.ref.webUrl, den.admin);
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/dashboards/${dashboardId}`);
  await waitFor(browser, `document.body.innerText.includes(${JSON.stringify(dashboardName)})
    && [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === "Add app")`, {
    timeoutMs: 90_000,
    label: "Den Web dashboard detail with Add app control",
  });

  const pickerRowScript = `
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((entry) => (entry.querySelector("h2")?.textContent ?? "").trim() === "Add app");
    const row = dialog
      ? [...dialog.querySelectorAll("div")]
        .filter((entry) => entry.querySelector("p")?.textContent === ${JSON.stringify(appToolTitle)})
        .at(-1)?.closest(".px-4")
      : null;
  `;

  const openPickerAndAdd = (launchInput: Record<string, unknown>) => evalIn(browser, `(() => {
    ${pickerRowScript}
    if (!(row instanceof HTMLElement)) return "app row not found";
    const textarea = row.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) return "launch input textarea not found";
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return "textarea value setter not found";
    setter.call(textarea, ${JSON.stringify(JSON.stringify(launchInput))});
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    const addButton = [...row.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim() === "Add");
    if (!(addButton instanceof HTMLButtonElement) || addButton.disabled) return "Add button not available";
    addButton.click();
    return "added";
  })()`);

  const pickerOpened = await evalIn(browser, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").trim() === "Add app");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(pickerOpened).toBe(true);
  await waitFor(browser, `(() => {
    ${pickerRowScript}
    return row instanceof HTMLElement && Boolean(row.querySelector("textarea"));
  })()`, {
    timeoutMs: 90_000,
    label: "MCP App picker row with launch input for the witness tool",
  });

  const firstAdd = await openPickerAndAdd(firstArguments);
  expect(firstAdd).toBe("added");
  const afterFirstAdd = await eventually(
    () => readDashboardElements(den.admin, dashboardId),
    {
      within: 60_000,
      intervalMs: 1_000,
      label: "first same-capability tile persisted in Den",
      until: (elements) => elements.length === 1,
    },
  );
  expect(afterFirstAdd).toEqual([{ toolName: appToolName, jql: firstArguments.jql }]);

  // The reported limitation: after one add, the picker must still offer the
  // same capability (with a fresh launch-input field) instead of a terminal
  // "Added" state, so a member can add a second tile with different arguments.
  await screenshot(browser);
  const secondAddOffer = await evalIn(browser, `(() => {
    ${pickerRowScript}
    if (!(row instanceof HTMLElement)) return null;
    return {
      addButtonVisible: [...row.querySelectorAll("button")]
        .some((button) => (button.textContent ?? "").trim() === "Add"),
      addedBadgeVisible: row.innerText.includes("Added"),
      launchInputVisible: Boolean(row.querySelector("textarea")),
    };
  })()`);
  expect(
    secondAddOffer,
    "After one tile is added, the picker row must keep its Add button and launch-input field for a second tile of the same capability",
  ).toEqual({
    addButtonVisible: true,
    addedBadgeVisible: false,
    launchInputVisible: true,
  });
  evidence.recordAssertionEvidence(
    "The Add app picker keeps offering an already-added capability for a second tile with different launch input",
    `Picker row state after the first add: ${JSON.stringify(secondAddOffer)}`,
    isRecord(secondAddOffer)
      && secondAddOffer.addButtonVisible === true
      && secondAddOffer.addedBadgeVisible === false
      && secondAddOffer.launchInputVisible === true,
  );

  const secondAdd = await openPickerAndAdd(secondArguments);
  expect(secondAdd).toBe("added");
  const afterSecondAdd = await eventually(
    () => readDashboardElements(den.admin, dashboardId),
    {
      within: 60_000,
      intervalMs: 1_000,
      label: "second same-capability tile persisted in Den",
      until: (elements) => elements.length === 2,
    },
  );
  // Both tiles call the same capability with their own arguments; the first
  // tile is neither replaced nor deduplicated by the second.
  expect(afterSecondAdd).toEqual([
    { toolName: appToolName, jql: firstArguments.jql },
    { toolName: appToolName, jql: secondArguments.jql },
  ]);
  const tileTitles = await evalIn(browser, `(() => {
    const doneButton = [...document.querySelectorAll('[role="dialog"] button')]
      .find((button) => (button.textContent ?? "").trim() === "Done");
    if (doneButton instanceof HTMLButtonElement) doneButton.click();
    const sections = [...document.querySelectorAll("section")];
    const appsSection = sections.find((section) => (section.querySelector("h2")?.textContent ?? "").trim() === "Apps");
    if (!appsSection) return null;
    return [...appsSection.querySelectorAll("p")]
      .map((entry) => (entry.textContent ?? "").trim())
      .filter((text) => text.startsWith(${JSON.stringify(appToolName)}) || text === ${JSON.stringify(appToolTitle)});
  })()`);
  await screenshot(browser);
  evidence.recordAssertionEvidence(
    "Two tiles of the same MCP App capability with different launch arguments coexist on one dashboard",
    `Persisted elements: ${JSON.stringify(afterSecondAdd)}; rendered app rows: ${JSON.stringify(tileTitles)}`,
    afterSecondAdd.length === 2
      && afterSecondAdd[0].toolName === appToolName
      && afterSecondAdd[1].toolName === appToolName
      && afterSecondAdd[0].jql === firstArguments.jql
      && afterSecondAdd[1].jql === secondArguments.jql
      && afterSecondAdd[0].jql !== afterSecondAdd[1].jql,
  );
});
