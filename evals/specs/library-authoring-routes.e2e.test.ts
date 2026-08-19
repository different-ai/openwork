import { expect } from "vitest";
import {
  createOrgConnection,
  denFetch,
  evalIn,
  fill,
  go,
  waitFor,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { app, eventually, faultProxy, mcpMock, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Library authoring and routes skipped — needs: ${missingRequirements.join(", ")}`
  : "Library authoring persists in Den and desktop and web rows open their details";

const addChoices = [
  "Skill",
  "Command",
  "Agent",
  "Plugin",
  "MCP server",
  "Connection",
];
const forbiddenFlashes = [
  "Your library is empty.",
  "No library items match these filters.",
  "This library item is not available in the current workspace.",
];

type AuthoredSkill = {
  pluginId: string;
  rawSourceText: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function organizationId(session: DenSession): Promise<string> {
  const response = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const orgs = isRecord(response.body) ? records(response.body.orgs) : [];
  const id = orgs[0] && typeof orgs[0].id === "string" ? orgs[0].id : "";
  if (!response.response.ok || !id) {
    throw new Error(`Resolving the test organization failed: HTTP ${response.response.status} ${response.text.slice(0, 500)}`);
  }
  return id;
}

async function readAuthoredSkill(
  session: DenSession,
  orgId: string,
  pluginName: string,
): Promise<AuthoredSkill | null> {
  const listed = await denFetch(session, `/v1/plugins?q=${encodeURIComponent(pluginName)}&limit=20`, {
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  if (!listed.response.ok || !isRecord(listed.body)) return null;
  const plugin = records(listed.body.items).find((item) => item.name === pluginName);
  const pluginId = plugin && typeof plugin.id === "string" ? plugin.id : "";
  if (!pluginId) return null;

  const resolved = await denFetch(session, `/v1/plugins/${encodeURIComponent(pluginId)}/resolved`, {
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  if (!resolved.response.ok || !isRecord(resolved.body)) return null;
  for (const item of records(resolved.body.items)) {
    if (!isRecord(item.configObject) || item.configObject.objectType !== "skill") continue;
    const latestVersion = isRecord(item.configObject.latestVersion) ? item.configObject.latestVersion : null;
    const rawSourceText = latestVersion && typeof latestVersion.rawSourceText === "string"
      ? latestVersion.rawSourceText
      : "";
    if (rawSourceText) return { pluginId, rawSourceText };
  }
  return null;
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  const stamp = Date.now();
  const skillName = `library-route-proof-${stamp}`;
  const description = `Exact Den description ${stamp}`;
  const instructions = `# Exact instructions\n\nReturn library route proof ${stamp}.`;
  const expectedSource = `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${instructions}`;
  const connectionName = `Library route connection ${stamp}`;

  await using den = await server({
    place,
    org: {
      name: `Library authoring routes ${stamp}`,
      admin: { name: "Library Route Admin" },
    },
    mocks: { connector: mcpMock() },
  });
  const orgId = await organizationId(den.admin);
  const connection = await createOrgConnection(den.admin, {
    name: connectionName,
    url: den.mocks.connector.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  await using proxy = await faultProxy(den.ref, {
    place,
    sandbox: den.placement?.kind === "daytona" ? den.placement.sandboxId : undefined,
  });
  const appDen = { ...den, ref: proxy.ref };

  await using desktop = await app({
    den: appDen,
    as: "admin",
    place,
    beforeSignIn: async (surface) => {
      await go(surface, "/extensions");
      await waitFor(surface, `document.body.innerText.includes("Library")
        && Boolean(document.querySelector('input[placeholder="Search your library"]'))`, {
        timeoutMs: 60_000,
        label: "signed-out desktop Library",
      });
      const signedOutAddVisible = await evalIn(surface, `[...document.querySelectorAll("button")]
        .some((button) => (button.textContent ?? "").trim() === "Add")`);
      expect(signedOutAddVisible).toBe(false);
      evidence.recordAssertionEvidence(
        "Signed-out desktop Library hides Add",
        "app.beforeSignIn opened /extensions and found the Library search control but no button whose exact label was Add.",
        signedOutAddVisible === false,
      );
    },
  });

  await go(desktop, `/workspace/${desktop.workspaceId}/extensions`);
  await waitFor(desktop, `[...document.querySelectorAll("button")]
    .some((button) => (button.textContent ?? "").trim() === "Add")`, {
    timeoutMs: 90_000,
    label: "signed-in desktop Library Add control",
  });
  const addOpened = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").trim() === "Add");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(addOpened).toBe(true);
  await waitFor(desktop, `[...document.querySelectorAll('[role="dialog"] h2')]
    .some((heading) => (heading.textContent ?? "").trim() === "Add to your Library")
    && [...document.querySelectorAll('[role="radio"]')]
      .some((item) => (item.textContent ?? "").includes("Connection"))`, {
    timeoutMs: 20_000,
    label: "all signed-in Library Add choices",
  });
  const visibleAddChoices = await evalIn(desktop, `[...document.querySelectorAll("[data-kind-title]")]
    .map((item) => (item.textContent ?? "").trim())`);
  expect(visibleAddChoices).toEqual(addChoices);
  evidence.recordAssertionEvidence(
    "Signed-in desktop Library shows Add and all six kind rows",
    `The open Add picker contained exact titles ${JSON.stringify(visibleAddChoices)}.`,
    JSON.stringify(visibleAddChoices) === JSON.stringify(addChoices),
  );

  const skillChoiceClicked = await evalIn(desktop, `(() => {
    const item = [...document.querySelectorAll('[role="radio"]')]
      .find((entry) => (entry.getAttribute("data-kind") ?? "") === "skill");
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    const continueButton = [...document.querySelectorAll('[role="dialog"] button')]
      .find((entry) => (entry.textContent ?? "").trim() === "Continue");
    if (!(continueButton instanceof HTMLButtonElement) || continueButton.disabled) return false;
    continueButton.click();
    return true;
  })()`);
  expect(skillChoiceClicked).toBe(true);
  await waitFor(desktop, `[...document.querySelectorAll('[role="dialog"] h2')]
    .some((heading) => (heading.textContent ?? "").trim() === "Create a skill")`, {
    timeoutMs: 20_000,
    label: "Create a skill modal",
  });
  await fill(desktop, 'input[placeholder="e.g. customer-research"]', skillName);
  await fill(desktop, 'input[placeholder="When should an agent use this skill?"]', description);
  await fill(desktop, 'textarea[placeholder^="# Instructions"]', instructions);
  await proxy.faults.latency("/api/den/v1/plugins/", 5_000, { times: 1 });

  const observerInstalled = await evalIn(desktop, `(() => {
    const forbidden = ${JSON.stringify(forbiddenFlashes)};
    const flashes = [];
    let modalClosed = false;
    const record = () => {
      const createDialogOpen = [...document.querySelectorAll('[role="dialog"] h2')]
        .some((heading) => (heading.textContent ?? "").trim() === "Create a skill");
      if (createDialogOpen) return;
      modalClosed = true;
      const text = document.body.innerText;
      for (const phrase of forbidden) {
        if (text.includes(phrase) && !flashes.includes(phrase)) flashes.push(phrase);
      }
    };
    const observer = new MutationObserver(record);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    window.__openworkLibraryFlashProbe = { flashes, observer, modalClosed: () => modalClosed };
    return true;
  })()`);
  expect(observerInstalled).toBe(true);

  const createClicked = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')]
      .find((entry) => (entry.textContent ?? "").trim() === "Create skill");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(createClicked).toBe(true);

  await waitFor(desktop, `(() => {
    const decoded = decodeURIComponent(location.hash);
    return decoded.includes("/extensions/plugin:")
      && ![...document.querySelectorAll('[role="dialog"] h2')]
        .some((heading) => (heading.textContent ?? "").trim() === "Create a skill")
      && document.body.innerText.includes(${JSON.stringify(skillName)})
      && document.body.innerText.includes(${JSON.stringify(description)});
  })()`, {
    timeoutMs: 90_000,
    label: "optimistic plugin detail while resolved hydration is delayed",
  });
  const optimisticDetail = await evalIn(desktop, `({
    route: decodeURIComponent(location.hash),
    modalClosed: window.__openworkLibraryFlashProbe?.modalClosed() ?? false,
    flashes: [...(window.__openworkLibraryFlashProbe?.flashes ?? [])],
    hasName: document.body.innerText.includes(${JSON.stringify(skillName)}),
    hasDescription: document.body.innerText.includes(${JSON.stringify(description)}),
  })`);
  expect(optimisticDetail).toMatchObject({
    modalClosed: true,
    flashes: [],
    hasName: true,
    hasDescription: true,
  });

  const authored = await eventually(
    () => readAuthoredSkill(den.admin, orgId, skillName),
    {
      within: 90_000,
      intervalMs: 1_000,
      label: "desktop-authored skill persisted in Den",
      until: (value) => value !== null,
    },
  );
  if (!authored) throw new Error(`Den never returned the desktop-authored skill ${skillName}.`);
  expect(authored.rawSourceText).toBe(expectedSource);
  evidence.recordAssertionEvidence(
    "Real desktop UI creates a skill and Den persists its exact content",
    `Plugin ${authored.pluginId} resolved to the exact ${expectedSource.length}-character SKILL.md submitted through the modal.`,
    authored.rawSourceText === expectedSource,
  );
  const hydrationRequests = await eventually(
    () => proxy.requestLog(),
    {
      within: 30_000,
      intervalMs: 500,
      label: "faulted resolved-plugin hydration request",
      until: (requests) => requests.some((request) => request.method === "GET"
        && request.path.startsWith(`/api/den/v1/plugins/${authored.pluginId}/resolved`)
        && request.faulted),
    },
  );
  const delayedHydrationObserved = hydrationRequests.some((request) => request.method === "GET"
    && request.path.startsWith(`/api/den/v1/plugins/${authored.pluginId}/resolved`)
    && request.faulted);
  expect(delayedHydrationObserved).toBe(true);
  evidence.recordAssertionEvidence(
    "Optimistic skill detail bridges deliberately delayed Library hydration",
    `The modal closed into ${JSON.stringify(optimisticDetail)} while a faulted five-second GET for plugin ${authored.pluginId} resolved hydration completed afterward.`,
    delayedHydrationObserved
      && isRecord(optimisticDetail)
      && optimisticDetail.modalClosed === true
      && Array.isArray(optimisticDetail.flashes)
      && optimisticDetail.flashes.length === 0
      && optimisticDetail.hasName === true
      && optimisticDetail.hasDescription === true,
  );

  await waitFor(desktop, `decodeURIComponent(location.hash).includes(${JSON.stringify(`/extensions/plugin:${authored.pluginId}`)})
    && document.body.innerText.includes(${JSON.stringify(skillName)})
    && document.body.innerText.includes(${JSON.stringify(description)})
    && [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === "Library")`, {
    timeoutMs: 90_000,
    label: "hydrated desktop plugin detail with Library back control",
  });
  const desktopPluginDetail = await evalIn(desktop, `({
    route: decodeURIComponent(location.hash),
    hasName: document.body.innerText.includes(${JSON.stringify(skillName)}),
    hasDescription: document.body.innerText.includes(${JSON.stringify(description)}),
    backLabel: [...document.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim() === "Library")?.textContent?.trim() ?? "",
  })`);
  evidence.recordAssertionEvidence(
    "Desktop plugin detail uses its routed URL and has a Library back control",
    `Observed ${JSON.stringify(desktopPluginDetail)}.`,
    isRecord(desktopPluginDetail)
      && typeof desktopPluginDetail.route === "string"
      && desktopPluginDetail.route.includes(`/extensions/plugin:${authored.pluginId}`)
      && desktopPluginDetail.hasName === true
      && desktopPluginDetail.hasDescription === true
      && desktopPluginDetail.backLabel === "Library",
  );

  const desktopBackClicked = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").trim() === "Library");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(desktopBackClicked).toBe(true);
  await waitFor(desktop, `decodeURIComponent(location.hash).endsWith("/extensions")
    && document.body.innerText.includes(${JSON.stringify(skillName)})`, {
    timeoutMs: 90_000,
    label: "hydrated authored skill in desktop Library",
  });
  const flashProbe = await evalIn(desktop, `(() => {
    const probe = window.__openworkLibraryFlashProbe;
    if (!probe) return null;
    probe.observer.disconnect();
    return { modalClosed: probe.modalClosed(), flashes: [...probe.flashes] };
  })()`);
  expect(flashProbe).toEqual({ modalClosed: true, flashes: [] });
  evidence.recordAssertionEvidence(
    "No empty, filtered-empty, or unavailable state flashes after create",
    `A MutationObserver installed before submit remained active through modal close, plugin detail, Library back, and the hydrated ${skillName} row: ${JSON.stringify(flashProbe)}.`,
    isRecord(flashProbe)
      && flashProbe.modalClosed === true
      && Array.isArray(flashProbe.flashes)
      && flashProbe.flashes.length === 0,
  );

  const connectionClicked = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connectionName)}));
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(connectionClicked).toBe(true);
  await waitFor(desktop, `decodeURIComponent(location.hash).includes(${JSON.stringify(`/extensions/org-mcp:${connection.id}`)})
    && document.body.innerText.includes(${JSON.stringify(connectionName)})
    && document.body.innerText.includes("OAuth required")
    && document.body.innerText.includes("Shared by your organization")
    && document.body.innerText.includes("Your account")
    && document.body.innerText.includes("Not connected")
    && [...document.querySelectorAll("button")]
      .some((button) => (button.textContent ?? "").trim() === "Connect your account")`, {
    timeoutMs: 60_000,
    label: "desktop organization connection detail route and content",
  });
  const desktopConnectionDetail = await evalIn(desktop, `({
    route: decodeURIComponent(location.hash),
    text: document.body.innerText,
  })`);
  evidence.recordAssertionEvidence(
    "Desktop organization connection row opens its detail route and content",
    `Connection ${connection.id} opened from Library with OAuth required, organization source, member account mode, and its connect action.`,
    isRecord(desktopConnectionDetail)
      && typeof desktopConnectionDetail.route === "string"
      && desktopConnectionDetail.route.includes(`/extensions/org-mcp:${connection.id}`)
      && typeof desktopConnectionDetail.text === "string"
      && desktopConnectionDetail.text.includes(connectionName)
      && desktopConnectionDetail.text.includes("OAuth required")
      && desktopConnectionDetail.text.includes("Shared by your organization")
      && desktopConnectionDetail.text.includes("Your account")
      && desktopConnectionDetail.text.includes("Not connected")
      && desktopConnectionDetail.text.includes("Connect your account"),
  );

  await using browser = await chrome({
    name: "library-authoring-routes",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before token handoff",
  });
  await evalIn(browser, `localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)})`);
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/library`);
  await waitFor(browser, `document.body.innerText.includes("My Library")
    && [...document.querySelectorAll("button")].some((button) => /^Show \\d+ more$/.test((button.textContent ?? "").trim()))`, {
    timeoutMs: 60_000,
    label: "Den Web My Library collapsed ready rows",
  });
  const expandedLibraryRows = await evalIn(browser, `(() => {
    const buttons = [...document.querySelectorAll("button")]
      .filter((button) => /^Show \\d+ more$/.test((button.textContent ?? "").trim()));
    for (const button of buttons) button.click();
    return buttons.length;
  })()`);
  expect(typeof expandedLibraryRows === "number" ? expandedLibraryRows : 0).toBeGreaterThan(0);
  await waitFor(browser, `document.body.innerText.includes(${JSON.stringify(skillName)})
    && document.body.innerText.includes(${JSON.stringify(connectionName)})`, {
    timeoutMs: 90_000,
    label: "Den Web My Library authored plugin and connection rows",
  });

  const pluginRowLink = await evalIn(browser, `(() => {
    const row = [...document.querySelectorAll('[data-library-item-type="plugin"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(skillName)}));
    const link = row?.closest("a") ?? row?.querySelector("a");
    const href = link?.getAttribute("href") ?? "";
    if (link instanceof HTMLElement) link.click();
    return href;
  })()`);
  expect(pluginRowLink).toBe(`/dashboard/library/plugins/${authored.pluginId}`);
  await waitFor(browser, `location.pathname === ${JSON.stringify(`/dashboard/library/plugins/${authored.pluginId}`)}
    && document.body.innerText.includes(${JSON.stringify(skillName)})
    && [...document.querySelectorAll("a")].some((link) =>
      (link.textContent ?? "").trim() === "Back" && link.getAttribute("href") === "/dashboard/library"
    )`, {
    timeoutMs: 60_000,
    label: "Den Web Library plugin detail and Back to library",
  });
  evidence.recordAssertionEvidence(
    "Den Web My Library plugin row links and clicks to its detail with Back to library",
    `The row href and resulting pathname were /dashboard/library/plugins/${authored.pluginId}; the exact visible Back link targeted /dashboard/library.`,
    pluginRowLink === `/dashboard/library/plugins/${authored.pluginId}`,
  );

  await navigate(browser.client, `${den.ref.webUrl}/dashboard/library`);
  await waitFor(browser, `document.body.innerText.includes(${JSON.stringify(connectionName)})`, {
    timeoutMs: 60_000,
    label: "Den Web connection row after returning to My Library",
  });
  const expectedConnectionHref = `/dashboard/your-connections?connectionId=${encodeURIComponent(connection.id)}`;
  const connectionRowLink = await evalIn(browser, `(() => {
    const row = [...document.querySelectorAll('[data-library-item-type="connection"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connectionName)}));
    const link = row?.closest("a") ?? row?.querySelector("a");
    const href = link?.getAttribute("href") ?? "";
    if (link instanceof HTMLElement) link.click();
    return href;
  })()`);
  expect(connectionRowLink).toBe(expectedConnectionHref);
  await waitFor(browser, `location.pathname === "/dashboard/your-connections"
    && new URLSearchParams(location.search).get("connectionId") === ${JSON.stringify(connection.id)}
    && (document.activeElement?.textContent ?? "").includes(${JSON.stringify(connectionName)})`, {
    timeoutMs: 60_000,
    label: "Den Web matching connection row focused from Library",
  });
  const focusedConnection = await evalIn(browser, `({
    path: location.pathname,
    connectionId: new URLSearchParams(location.search).get("connectionId"),
    focusedText: (document.activeElement?.textContent ?? "").replace(/\\s+/g, " ").trim(),
  })`);
  evidence.recordAssertionEvidence(
    "Den connection row links and clicks to Your Connections and focuses the matching row",
    `The row href was ${connectionRowLink}; resulting focus was ${JSON.stringify(focusedConnection)}.`,
    connectionRowLink === expectedConnectionHref
      && isRecord(focusedConnection)
      && focusedConnection.path === "/dashboard/your-connections"
      && focusedConnection.connectionId === connection.id
      && typeof focusedConnection.focusedText === "string"
      && focusedConnection.focusedText.includes(connectionName),
  );
});
