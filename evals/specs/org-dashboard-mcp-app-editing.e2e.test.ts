import { expect } from "vitest";
import { denFetch, evalIn, fill, signInInBrowser, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `organization dashboard MCP App editing skipped — needs: ${missingRequirements.join(", ")}`
  : "an admin edits an existing dashboard MCP App and adds saved tool input";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

type DashboardElement = {
  serverName: string;
  connectionId: string;
  toolName: string;
  projectedToolName: string;
  resourceUri: string;
  title: string;
  launchArguments?: Record<string, unknown>;
};

const budgetApp: DashboardElement = {
  serverName: "openwork-app-host-connect-budgetfixture",
  connectionId: "emc_01budgetdashboardfixture00000",
  toolName: "allocate_budget",
  projectedToolName: "openwork-app-host-connect-budgetfixture_allocate_budget",
  resourceUri: "ui://budget-allocator/view.html",
  title: "Budget allocator",
};

async function createDashboard(session: DenSession, name: string): Promise<string> {
  const response = await denFetch(session, "/v1/dashboards", {
    method: "POST",
    headers: auth(session),
    body: JSON.stringify({ name, elements: [budgetApp] }),
  });
  const item = isRecord(response.body) && isRecord(response.body.item) ? response.body.item : null;
  const id = item && typeof item.id === "string" ? item.id : "";
  if (response.response.status !== 201 || !id) {
    throw new Error(`Creating the dashboard failed: HTTP ${response.response.status} ${response.text.slice(0, 500)}`);
  }
  return id;
}

async function readElements(session: DenSession, dashboardId: string): Promise<DashboardElement[]> {
  const response = await denFetch(session, `/v1/dashboards/${encodeURIComponent(dashboardId)}`, {
    headers: auth(session),
  });
  const item = isRecord(response.body) && isRecord(response.body.item) ? response.body.item : null;
  const elements = item && Array.isArray(item.elements) ? item.elements.filter(isRecord) : [];
  if (!response.response.ok || elements.length !== 1) {
    throw new Error(`Reading the dashboard failed: HTTP ${response.response.status} ${response.text.slice(0, 500)}`);
  }
  return elements.flatMap((element) => {
    if (
      typeof element.serverName !== "string"
      || typeof element.connectionId !== "string"
      || typeof element.toolName !== "string"
      || typeof element.projectedToolName !== "string"
      || typeof element.resourceUri !== "string"
      || typeof element.title !== "string"
    ) return [];
    return [{
      serverName: element.serverName,
      connectionId: element.connectionId,
      toolName: element.toolName,
      projectedToolName: element.projectedToolName,
      resourceUri: element.resourceUri,
      title: element.title,
      ...(isRecord(element.launchArguments) ? { launchArguments: element.launchArguments } : {}),
    }];
  });
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  const stamp = Date.now();
  const dashboardName = `Budget planning ${stamp}`;
  const updatedTitle = `Quarterly budget planner ${stamp}`;
  const updatedInput = {
    budget: 250000,
    currency: "USD",
    priorities: ["reliability", "growth"],
  };

  await using den = await server({
    place,
    env: { DEN_DASHBOARDS_ENABLED: "true" },
    org: {
      name: `Dashboard editing ${stamp}`,
      admin: { name: "Dashboard Editor" },
    },
  });
  const dashboardId = await createDashboard(den.admin, dashboardName);

  await using browser = await chrome({
    name: "org-dashboard-mcp-app-editing",
    startUrl: "about:blank",
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await browser.client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const webOrigin = ${JSON.stringify(new URL(den.ref.webUrl).origin)};
      const apiOrigin = ${JSON.stringify(new URL(den.ref.apiUrl).origin)};
      const derivedApiUrl = new URL(webOrigin);
      if (derivedApiUrl.hostname !== "api" && !derivedApiUrl.hostname.startsWith("api.")) {
        derivedApiUrl.hostname = "api." + derivedApiUrl.hostname;
      }
      const derivedApiOrigin = derivedApiUrl.origin;
      if (location.origin === webOrigin) {
        localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)});
      }
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const href = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
        const url = new URL(href, location.href);
        if (url.origin !== apiOrigin && url.origin !== derivedApiOrigin) return originalFetch(input, init);
        const targetUrl = url.pathname.startsWith("/api/auth/")
          ? new URL(url.pathname + url.search, webOrigin)
          : new URL(url.pathname + url.search, apiOrigin);
        if (input instanceof Request) {
          return originalFetch(new Request(targetUrl, input), init);
        }
        return originalFetch(targetUrl, init);
      };
    })();`,
  });
  await signInInBrowser(browser, `${den.ref.webUrl}/dashboard/dashboards/${encodeURIComponent(dashboardId)}`, {
    email: den.admin.email,
    password: den.admin.password,
  });
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/dashboards/${encodeURIComponent(dashboardId)}`);
  await waitFor(browser, `(() => {
    const edit = document.querySelector(${JSON.stringify(`button[aria-label="Edit ${budgetApp.title}"]`)});
    return location.pathname === ${JSON.stringify(`/dashboard/dashboards/${dashboardId}`)}
      && document.body.innerText.includes(${JSON.stringify(dashboardName)})
      && edit instanceof HTMLButtonElement
      && !edit.disabled;
  })()`, {
    timeoutMs: 60_000,
    label: "existing dashboard app edit action",
  });

  const editOpened = await evalIn(browser, `(() => {
    const button = document.querySelector(${JSON.stringify(`button[aria-label="Edit ${budgetApp.title}"]`)});
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(editOpened).toBe(true);
  await waitFor(browser, `(() => {
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="edit-dashboard-app-title"]');
    const name = dialog?.querySelector('input[aria-label="Display name"]');
    const input = dialog?.querySelector('textarea[aria-label="Tool input"]');
    return dialog instanceof HTMLElement
      && name instanceof HTMLInputElement
      && name.value === ${JSON.stringify(budgetApp.title)}
      && input instanceof HTMLTextAreaElement
      && input.value === "";
  })()`, {
    timeoutMs: 30_000,
    label: "existing app values in edit dialog",
  });
  evidence.recordAssertionEvidence(
    "An organization admin can open an existing MCP App tile for editing",
    `Dashboard ${dashboardId} opened an Edit app dialog with display name ${budgetApp.title} and blank tool input.`,
    editOpened === true,
  );

  await fill(browser, 'textarea[aria-label="Tool input"]', "[]");
  const invalidSaveClicked = await evalIn(browser, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => (entry.textContent ?? '').trim() === 'Save changes');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(invalidSaveClicked).toBe(true);
  await waitFor(browser, `document.body.innerText.includes("Tool input must be a JSON object.")`, {
    timeoutMs: 10_000,
    label: "invalid dashboard app input rejected",
  });
  const afterInvalidSave = await readElements(den.admin, dashboardId);
  expect(afterInvalidSave).toEqual([budgetApp]);
  evidence.recordAssertionEvidence(
    "Invalid non-object tool input cannot replace the saved dashboard element",
    `The UI rejected [] and Den still returned ${JSON.stringify(afterInvalidSave)}.`,
    afterInvalidSave.length === 1
      && afterInvalidSave[0]?.title === budgetApp.title
      && afterInvalidSave[0]?.launchArguments === undefined,
  );

  await fill(browser, 'input[aria-label="Display name"]', updatedTitle);
  await fill(browser, 'textarea[aria-label="Tool input"]', JSON.stringify(updatedInput, null, 2));
  const validSaveClicked = await evalIn(browser, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((entry) => (entry.textContent ?? '').trim() === 'Save changes');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(validSaveClicked).toBe(true);
  await waitFor(browser, `(() => {
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="edit-dashboard-app-title"]');
    return !dialog && document.body.innerText.includes(${JSON.stringify(updatedTitle)});
  })()`, {
    timeoutMs: 30_000,
    label: "saved dashboard app edit",
  });

  const savedElements = await readElements(den.admin, dashboardId);
  const saved = savedElements[0];
  expect(saved).toEqual({
    ...budgetApp,
    title: updatedTitle,
    launchArguments: updatedInput,
  });
  evidence.recordAssertionEvidence(
    "Editing a dashboard MCP App persists its display name and launch input without changing its binding",
    `Den returned one element after save: ${JSON.stringify(saved)}.`,
    savedElements.length === 1
      && saved?.title === updatedTitle
      && JSON.stringify(saved.launchArguments) === JSON.stringify(updatedInput)
      && saved?.serverName === budgetApp.serverName
      && saved?.connectionId === budgetApp.connectionId
      && saved?.toolName === budgetApp.toolName
      && saved?.projectedToolName === budgetApp.projectedToolName
      && saved?.resourceUri === budgetApp.resourceUri,
  );
});
