import { expect, onTestFinished, test } from "vitest";
import {
  createOrgConnection,
  deleteConnection,
  deleteConnectionsNamed,
  denFetch,
  ensureMemberSession,
  evalIn,
  signIn,
  waitFor,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { allocateFreePort, navigate } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { createVisualEvidence, screenshot, validate } from "@openwork/test-evidence";
import { chrome } from "@openwork/hosts";
import { startMockMcp } from "@openwork/labs";

const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "") ?? "";
const webUrl = process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim().replace(/\/+$/, "") ?? "";
const title = !apiUrl
  ? "library view skipped: set OPENWORK_EVAL_DEN_API_URL to a running Den API"
  : !webUrl
    ? "library view skipped: set OPENWORK_EVAL_DEN_WEB_URL to a running Den Web"
    : "members can browse their plugin library and its access provenance";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = orgs.find((entry) => entry.slug === "acme-robotics-demo")
    ?? orgs.find((entry) => entry.name === "Acme Robotics")
    ?? orgs[0];
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding Acme Robotics failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function selectOrganization(session: DenSession, orgId: string): Promise<void> {
  const result = await denFetch(session, "/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ organizationId: orgId }),
  });
  if (!result.response.ok) {
    throw new Error(`Selecting Acme Robotics failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

async function organizationMemberIdByEmail(session: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(session, "/v1/org", {
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  const members = isRecord(result.body) && Array.isArray(result.body.members)
    ? result.body.members.filter(isRecord)
    : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const memberId = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !memberId.startsWith("om_")) {
    throw new Error(`Resolving ${email} in the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return memberId;
}

function items(body: unknown): Record<string, unknown>[] {
  return isRecord(body) && Array.isArray(body.items) ? body.items.filter(isRecord) : [];
}

function libraryItemId(item: Record<string, unknown>): string {
  return typeof item.id === "string" ? item.id : "";
}

function edgesForAccessItem(item: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(item.edges) ? item.edges.filter(isRecord) : [];
}

async function useMobileViewport(browser: Surface): Promise<void> {
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 812,
    deviceScaleFactor: 2,
    mobile: true,
  });
}

test.skipIf(!apiUrl || !webUrl)(title, async () => {
  const den = { apiUrl, webUrl };
  const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
  const admin = await signIn(den, {
    email: process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test",
    password,
  });
  const orgId = await organizationId(admin);
  await selectOrganization(admin, orgId);

  const mockPort = await allocateFreePort();
  await using mock = await startMockMcp({
    port: mockPort,
    publicUrl: process.env.OPENWORK_EVAL_LIBRARY_MOCK_PUBLIC_URL?.trim() || undefined,
  });
  await deleteConnectionsNamed(admin, "Library Spec Linear ");
  const connection = await createOrgConnection(admin, {
    name: `Library Spec Linear ${Date.now()}`,
    url: mock.url + "/mcp",
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  onTestFinished(async () => deleteConnection(admin, connection.id));

  let caseySession: DenSession | undefined;
  let pluginId = "";
  let teamId = "";
  onTestFinished(async () => {
    const casey = caseySession;
    const createdPluginId = pluginId;
    const createdTeamId = teamId;
    if (casey && createdPluginId) {
      await denFetch(casey, `/v1/plugins/${encodeURIComponent(createdPluginId)}/archive`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${casey.token}`,
          "x-openwork-org-id": orgId,
        },
      }).catch(() => undefined);
    }
    if (createdTeamId) {
      await denFetch(admin, `/v1/teams/${encodeURIComponent(createdTeamId)}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${admin.token}`,
          "x-openwork-org-id": orgId,
        },
      }).catch(() => undefined);
    }
  });

  const caseyEmail = process.env.OPENWORK_EVAL_CREATOR_EMAIL?.trim() || "casey.spec@acme.test";
  caseySession = await ensureMemberSession(den, admin, {
    email: caseyEmail,
    password: process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || password,
    name: "Casey Spec",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });
  const casey = caseySession;
  await selectOrganization(casey, orgId);

  const novaEmail = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "nova.spec@acme.test";
  const nova = await ensureMemberSession(den, admin, {
    email: novaEmail,
    password: process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || password,
    name: "Nova Spec",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });
  await selectOrganization(nova, orgId);

  const stamp = Date.now();
  const pluginName = `AAA Spec Library Plugin ${stamp}`;
  const skillName = `spec-library-${stamp}`;
  const rawSourceText = `---\nname: ${skillName}\ndescription: Proves the member library view.\n---\n\nReturn the library proof phrase.`;
  const createdPlugin = await denFetch(casey, "/v1/plugins", {
    method: "POST",
    headers: {
      authorization: `Bearer ${casey.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({
      name: pluginName,
      sourceRepositoryUrl: "https://github.com/anthropics/knowledge-work-plugins",
      components: [{ type: "skill", input: { rawSourceText } }],
    }),
  });
  const plugin = isRecord(createdPlugin.body) && isRecord(createdPlugin.body.item) ? createdPlugin.body.item : null;
  pluginId = plugin && typeof plugin.id === "string" ? plugin.id : "";
  if (createdPlugin.response.status !== 201 || !pluginId) {
    throw new Error(`Creating the library plugin failed: HTTP ${createdPlugin.response.status} ${createdPlugin.text.slice(0, 500)}`);
  }

  const novaMemberId = await organizationMemberIdByEmail(casey, orgId, novaEmail);
  const teamName = `Spec Library Provenance Team ${stamp}`;
  const createdTeam = await denFetch(admin, "/v1/teams", {
    method: "POST",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ name: teamName }),
  });
  const team = isRecord(createdTeam.body) && isRecord(createdTeam.body.team) ? createdTeam.body.team : null;
  teamId = team && typeof team.id === "string" ? team.id : "";
  if (createdTeam.response.status !== 201 || !teamId) {
    throw new Error(`Creating the library provenance team failed: HTTP ${createdTeam.response.status} ${createdTeam.text.slice(0, 500)}`);
  }
  const updatedTeam = await denFetch(admin, `/v1/teams/${encodeURIComponent(teamId)}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${admin.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ memberIds: [novaMemberId] }),
  });
  if (!updatedTeam.response.ok) {
    throw new Error(`Adding Nova to the library provenance team failed: HTTP ${updatedTeam.response.status} ${updatedTeam.text.slice(0, 500)}`);
  }

  const grantedNova = await denFetch(casey, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${casey.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ orgMembershipId: novaMemberId, role: "viewer" }),
  });
  if (grantedNova.response.status !== 201) {
    throw new Error(`Granting Nova library access failed: HTTP ${grantedNova.response.status} ${grantedNova.text.slice(0, 500)}`);
  }
  const grantedTeam = await denFetch(casey, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${casey.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ teamId, role: "viewer" }),
  });
  if (grantedTeam.response.status !== 201) {
    throw new Error(`Granting the provenance team library access failed: HTTP ${grantedTeam.response.status} ${grantedTeam.text.slice(0, 500)}`);
  }

  const caseyAccess = await denFetch(casey, "/v1/me/library", {
    headers: {
      authorization: `Bearer ${casey.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  expect(caseyAccess.response.status).toBe(200);
  const caseyPlugin = items(caseyAccess.body).find((item) => item.type === "plugin" && libraryItemId(item) === pluginId);
  expect(caseyPlugin).toBeDefined();
  if (!caseyPlugin) throw new Error(`Casey's library omitted ${pluginName}: ${caseyAccess.text.slice(0, 500)}`);
  expect(caseyPlugin.role).toBe("manager");
  expect(edgesForAccessItem(caseyPlugin).some((edge) => edge.kind === "mine")).toBe(true);

  const novaAccess = await denFetch(nova, "/v1/me/library", {
    headers: {
      authorization: `Bearer ${nova.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  expect(novaAccess.response.status).toBe(200);
  const novaItems = items(novaAccess.body);
  const novaPlugin = novaItems.find((item) => item.type === "plugin" && libraryItemId(item) === pluginId);
  expect(novaPlugin).toBeDefined();
  if (!novaPlugin) throw new Error(`Nova's library omitted ${pluginName}: ${novaAccess.text.slice(0, 500)}`);
  expect(novaPlugin.role).toBe("viewer");
  expect(Array.isArray(novaPlugin.componentKinds) && novaPlugin.componentKinds.includes("skill")).toBe(true);
  expect(edgesForAccessItem(novaPlugin).some((edge) => {
    return edge.kind === "person"
      && isRecord(edge.sharedBy)
      && typeof edge.sharedBy.name === "string"
      && edge.sharedBy.name.includes("Casey");
  })).toBe(true);
  const novaConnection = novaItems.find((item) => item.type === "connection" && libraryItemId(item) === connection.id);
  expect(novaConnection).toBeDefined();
  if (!novaConnection) throw new Error(`Nova's library omitted ${connection.name}: ${novaAccess.text.slice(0, 500)}`);
  expect(novaConnection.transport).toBe("mcp");
  expect(novaConnection.state).toBe("needs_signin");
  const catalogName = "Anthropic Knowledge Work Plugins";
  expect(novaItems.some((item) => {
    return item.type === "plugin"
      && libraryItemId(item) !== pluginId
      && edgesForAccessItem(item).some((edge) => {
        return edge.kind === "catalog"
          && isRecord(edge.marketplace)
          && edge.marketplace.name === catalogName;
      });
  })).toBe(true);

  const capabilities = await denFetch(casey, "/v1/resources/marketplace-capabilities", {
    headers: {
      authorization: `Bearer ${casey.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  expect(capabilities.response.status).toBe(200);
  expect(items(capabilities.body).some((item) => item.pluginId === pluginId && item.marketplaceId === null)).toBe(true);

  await using browser = await chrome({ name: "p3-library", startUrl: webUrl, headless: true });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before Nova auth token handoff",
  });
  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(nova.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(nova.token)};
  })()`);
  expect(tokenStored).toBe(true);

  await navigate(browser.client, `${webUrl}/dashboard/library`);
  try {
    await waitFor(
      browser,
       `(() => {
         const text = document.body.innerText;
         const connectionRow = [...document.querySelectorAll('[data-library-item-type="connection"]')]
           .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connection.name)}));
         const tabs = [...document.querySelectorAll('[role="tab"]')].map((entry) => (entry.textContent ?? "").trim());
         const signInCaption = document.querySelector('[data-library-section="needs_signin"] h2');
         const fromFacet = [...document.querySelectorAll('[aria-label="Library filters"] label')]
           .some((entry) => (entry.textContent ?? "").includes("From ·"));
         return [...document.querySelectorAll("h1")].some((entry) => entry.textContent?.trim() === "My Library")
           && text.includes(${JSON.stringify(pluginName)})
           && Boolean(connectionRow)
           && tabs.some((label) => label.startsWith("Needs your sign-in"))
           && tabs.some((label) => label.startsWith("Ready to use"))
           && signInCaption?.textContent?.trim() === "NEEDS YOUR SIGN-IN"
           && fromFacet
           && [...document.querySelectorAll("[data-library-source]")].some((entry) =>
             (entry.textContent ?? "").replace(/\\s+/g, " ").includes("Shared by Casey")
           );
       })()`,
       { timeoutMs: 60_000, label: "frame 16 member library, state tabs, shared plugin, and sign-in section" },
    );
  } catch (error) {
    const pageState = await evalIn(browser, `({ href: location.href, text: document.body.innerText.slice(0, 1000) })`);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} Page state: ${JSON.stringify(pageState)}`);
  }
  const libraryNavPresent = await evalIn(
    browser,
    `[...document.querySelectorAll("aside, nav")].some((entry) => (entry.textContent ?? "").includes("Library"))`,
  );
  expect(libraryNavPresent).toBe(true);
  const descriptionOutsideHero = await evalIn(browser, `(() => {
    const heading = [...document.querySelectorAll("h1")].find((entry) => entry.textContent?.trim() === "My Library");
    const hero = heading?.closest("[data-dashboard-hero]");
    const description = [...document.querySelectorAll("p")].find((entry) => entry.textContent?.includes("Everything you can use in chat"));
    return Boolean(hero && description && !hero.contains(description));
  })()`);
  expect(descriptionOutsideHero).toBe(true);
  const descriptionBeforeTabs = await evalIn(browser, `(() => {
    const text = document.body.innerText;
    const descriptionIndex = text.indexOf("Everything you can use in chat");
    const firstTab = [...document.querySelectorAll('[role="tab"]')].find((entry) => entry.textContent?.trim() === "All");
    const tabIndex = firstTab ? text.indexOf(firstTab.textContent ?? "") : -1;
    return descriptionIndex >= 0 && tabIndex >= 0 && descriptionIndex < tabIndex;
  })()`);
  expect(descriptionBeforeTabs).toBe(true);
  const stateTabsAndFromFacetMatch = await evalIn(browser, `(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')]
      .map((entry) => (entry.textContent ?? "").trim());
    const filters = document.querySelector('[aria-label="Library filters"]');
    return tabs.some((label) => label === "All")
      && tabs.some((label) => label.startsWith("Needs your sign-in"))
      && tabs.some((label) => label.startsWith("Ready to use"))
      && !tabs.some((label) => label === "Mine" || label === "Shared with me")
      && Boolean(filters && (filters.textContent ?? "").includes("From ·"));
  })()`);
  expect(stateTabsAndFromFacetMatch).toBe(true);
  const kindPillRowHasCounts = await evalIn(browser, `(() => {
    const filters = document.querySelector('[aria-label="Library filters"]');
    return Boolean(filters && /Connections · \\d+/.test(filters.textContent ?? ""));
  })()`);
  expect(kindPillRowHasCounts).toBe(true);
  const connectionHasSignInLink = await evalIn(browser, `(() => {
    const row = [...document.querySelectorAll('[data-library-item-type="connection"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connection.name)}));
    const signIn = row ? [...row.querySelectorAll('a')].find((entry) => entry.textContent?.trim() === "Sign in") : null;
    return Boolean(signIn?.getAttribute("href")?.includes("your-connections"));
  })()`);
  expect(connectionHasSignInLink).toBe(true);
  const needsSignInRowIsInsideList = await evalIn(
    browser,
    `Boolean(document.querySelector('[data-library-list] [data-library-item-state="needs_signin"]'))`,
  );
  expect(needsSignInRowIsInsideList).toBe(true);
  const catalogNameOccurrenceCount = await evalIn(
    browser,
    `document.body.innerText.split(${JSON.stringify(catalogName)}).length - 1`,
  );
  expect(catalogNameOccurrenceCount).toBe(1);
  const absorbedBoilerplateAndChipLanes = await evalIn(browser, `(() => {
    const caption = document.querySelector('[data-library-section="needs_signin"] h2');
    const connectionRow = [...document.querySelectorAll('[data-library-item-type="connection"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connection.name)}));
    const pluginRow = [...document.querySelectorAll('[data-library-item-type="plugin"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(pluginName)}));
    const connectionChips = [...(connectionRow?.querySelectorAll('[data-library-chip]') ?? [])]
      .map((entry) => (entry.textContent ?? "").trim());
    const pluginChips = [...(pluginRow?.querySelectorAll('[data-library-chip]') ?? [])]
      .map((entry) => (entry.textContent ?? "").trim());
    return caption?.textContent?.trim() === "NEEDS YOUR SIGN-IN"
      && connectionChips.length > 0
      && connectionChips.length <= 3
      && connectionChips.includes("MCP")
      && pluginChips.some((label) => label === "Skill" || label === "Plugin")
      && pluginChips.length <= 2;
  })()`);
  expect(absorbedBoilerplateAndChipLanes).toBe(true);
  await waitFor(browser, `(() => {
    const pluginRow = [...document.querySelectorAll('[data-library-item-type="plugin"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(pluginName)}));
    return Boolean(pluginRow && [...pluginRow.querySelectorAll('img')]
      .some((image) => image.src.includes("github.com/anthropics.png")));
  })()`, { timeoutMs: 30_000, label: "GitHub owner avatar on the spec plugin row" });
  const pluginChipIsNeutral = await evalIn(browser, `(() => {
    const pluginRow = [...document.querySelectorAll('[data-library-item-type="plugin"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(pluginName)}));
    const kindChip = pluginRow?.querySelector('[data-library-chip]');
    return kindChip instanceof HTMLElement
      && getComputedStyle(kindChip).backgroundColor !== "rgb(254, 243, 199)";
  })()`);
  expect(pluginChipIsNeutral).toBe(true);

  const needsSignInTabClicked = await evalIn(browser, `(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')]
      .find((entry) => (entry.textContent ?? "").trim().startsWith("Needs your sign-in"));
    if (!(tab instanceof HTMLElement)) return false;
    tab.click();
    return true;
  })()`);
  expect(needsSignInTabClicked).toBe(true);
  await waitFor(browser, `(() => {
    const rows = [...document.querySelectorAll('[data-library-item-type]')];
    const connectionRow = rows.find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connection.name)}));
    return Boolean(connectionRow)
      && rows.length > 0
      && rows.every((entry) => entry.getAttribute("data-library-item-type") === "connection")
      && !document.querySelector('[data-library-item-type="plugin"]');
  })()`, { timeoutMs: 60_000, label: "only connections after selecting the needs-sign-in state tab" });
  const allTabClicked = await evalIn(browser, `(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')]
      .find((entry) => (entry.textContent ?? "").trim() === "All");
    if (!(tab instanceof HTMLElement)) return false;
    tab.click();
    return true;
  })()`);
  expect(allTabClicked).toBe(true);
  await waitFor(browser, `Boolean(document.querySelector('[data-library-item-type="plugin"]'))`, {
    timeoutMs: 60_000,
    label: "ready plugin rows after returning to the All state tab",
  });

  const readyTabClicked = await evalIn(browser, `(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')]
      .find((entry) => (entry.textContent ?? "").trim().startsWith("Ready to use"));
    if (!(tab instanceof HTMLElement)) return false;
    tab.click();
    return true;
  })()`);
  expect(readyTabClicked).toBe(true);
  await waitFor(browser, `(() => {
    const rows = [...document.querySelectorAll('[data-library-item-type]')];
    return rows.length > 0
      && Boolean(document.querySelector('[data-library-item-type="plugin"]'))
      && !rows.some((entry) => entry.getAttribute("data-library-item-state") === "needs_signin");
  })()`, { timeoutMs: 60_000, label: "only ready rows after selecting the ready-to-use state tab" });
  const allTabRestored = await evalIn(browser, `(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')]
      .find((entry) => (entry.textContent ?? "").trim() === "All");
    if (!(tab instanceof HTMLElement)) return false;
    tab.click();
    return true;
  })()`);
  expect(allTabRestored).toBe(true);
  await waitFor(browser, `Boolean([...document.querySelectorAll('[data-library-item-type="connection"]')]
    .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connection.name)})))`, {
    timeoutMs: 60_000,
    label: "needs-sign-in connection after returning to All",
  });

  const mcpFilterClicked = await evalIn(browser, `(() => {
    const filter = [...document.querySelectorAll('[aria-label="Library filters"] button')]
      .find((entry) => /^MCPs · \\d+$/.test((entry.textContent ?? "").trim()));
    filter?.click();
    return Boolean(filter);
  })()`);
  expect(mcpFilterClicked).toBe(true);
  await waitFor(browser, `(() => {
    const row = [...document.querySelectorAll('[data-library-item-type="connection"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connection.name)}));
    const pluginRow = document.querySelector('[data-library-item-type="plugin"]');
    if (!row || !pluginRow) return false;
    const rect = row.getBoundingClientRect();
    const pluginRect = pluginRow.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && pluginRect.width > 0 && pluginRect.height > 0;
  })()`, { timeoutMs: 60_000, label: "plugin and MCP-backed connection after selecting the MCPs facet" });
  const connectionScrolledIntoView = await evalIn(browser, `(() => {
    const row = [...document.querySelectorAll('[data-library-item-type="connection"]')]
      .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connection.name)}));
    row?.scrollIntoView({ block: "center" });
    return Boolean(row);
  })()`);
  expect(connectionScrolledIntoView).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 250));

  await using visualEvidence = createVisualEvidence("library-connector-ui");
  await evalIn(browser, `document.querySelector("[data-dashboard-hero]")?.scrollIntoView({ block: "start" })`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const desktopHeaderShot = await screenshot(browser);
  const desktopHeaderSeen = await validate(desktopHeaderShot, [
    "A compact gradient header is titled Library, with its description immediately below and before the tabs",
  ]);
  await visualEvidence.recordScreenshot(desktopHeaderShot, desktopHeaderSeen);
  expect(desktopHeaderSeen.ok, desktopHeaderSeen.why).toBe(true);

  await evalIn(browser, `([...document.querySelectorAll('[data-library-item-type="connection"]')]
    .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connection.name)})))
    ?.scrollIntoView({ block: "center" })`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const desktopShot = await screenshot(browser);
  const desktopSeen = await validate(desktopShot, [
    "Rows show a logo tile, a title with chips beside it, and one meta line inside a hairline-divided card",
    "A white needs-sign-in row shows an amber Connect your account chip and a dark Sign in button under a NEEDS YOUR SIGN-IN caption",
  ]);
  await visualEvidence.recordScreenshot(desktopShot, desktopSeen);
  expect(desktopSeen.ok, desktopSeen.why).toBe(true);

  await useMobileViewport(browser);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitFor(browser, `document.body.innerText.includes(${JSON.stringify(connection.name)})
    && Boolean(document.querySelector('[data-library-item-type="plugin"]'))`, {
    timeoutMs: 60_000,
    label: "plugin and connection after mobile reflow",
  });
  await evalIn(browser, `([...document.querySelectorAll('[data-library-item-type="connection"]')]
    .find((entry) => (entry.textContent ?? "").includes(${JSON.stringify(connection.name)})))
    ?.scrollIntoView({ block: "center" })`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const mobileShot = await screenshot(browser);
  const mobileSeen = await validate(mobileShot, [
    "A narrow mobile layout keeps rows readable with wrapped chips",
  ]);
  await visualEvidence.recordScreenshot(mobileShot, mobileSeen);
  expect(mobileSeen.ok, mobileSeen.why).toBe(true);

  await navigate(browser.client, `${webUrl}/dashboard/library?focus=${encodeURIComponent(`connection-${connection.id}`)}`);
  await waitFor(browser, `(() => {
    const row = document.querySelector('[data-library-focused][data-library-item-type="connection"]');
    return Boolean(row && (row.textContent ?? "").includes(${JSON.stringify(connection.name)}));
  })()`, {
    timeoutMs: 60_000,
    label: "focused connection row from the library deep link",
  });
});
