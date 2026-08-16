import { expect } from "vitest";
import { denFetch, evalIn, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/fraimz";
import { chrome } from "@openwork/hosts";
import { needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { NeedsSpec } from "@openwork/testkit";

const requirements: NeedsSpec = {
  optIn: ["OPENWORK_EVAL_APP_SPECS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `den sidebar information architecture skipped — needs: ${missingRequirements.join(", ")}`
  : "admins and members see different Den sidebar sections with the renamed destinations";

type SidebarSection = {
  name: string;
  items: string[];
  children: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSections(value: unknown): SidebarSection[] {
  if (!Array.isArray(value)) {
    throw new Error(`Sidebar sections were not an array: ${JSON.stringify(value)}`);
  }
  return value.map((entry, index) => {
    if (
      !isRecord(entry)
      || typeof entry.name !== "string"
      || !Array.isArray(entry.items)
      || !entry.items.every((item) => typeof item === "string")
      || !Array.isArray(entry.children)
      || !entry.children.every((item) => typeof item === "string")
    ) {
      throw new Error(`Sidebar section ${index} had an unexpected shape: ${JSON.stringify(entry)}`);
    }
    return { name: entry.name, items: entry.items, children: entry.children };
  });
}

function itemNames(sections: SidebarSection[]): string[] {
  return sections.flatMap((section) => section.items);
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

const readSidebar = `(() => {
  const nav = document.querySelector('[data-testid="den-org-sidebar"]');
  if (!nav) return null;
  return [...nav.querySelectorAll("[data-sidebar-section]")].map((section) => ({
    name: section.getAttribute("data-sidebar-section") ?? "",
    items: [...section.querySelectorAll(":scope > div > div > a")].map((link) =>
      (link.textContent ?? "").replace(/\\s+/g, " ").trim()
    ),
    children: [...section.querySelectorAll(":scope > div > div > div a")].map((link) =>
      (link.textContent ?? "").replace(/\\s+/g, " ").trim()
    ),
  }));
})()`;

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    org: {
      name: `Den Sidebar IA ${Date.now()}`,
      admin: { name: "Sarah" },
      members: { jordan: { name: "Jordan Eval" } },
    },
  });
  const member = den.members.jordan;
  if (!member) throw new Error("server() did not provision the jordan member session");

  const orgId = await organizationId(den.admin);
  const flip = await denFetch(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ capabilities: { codemodeScripts: true, mcpConnections: true, cloud: true } }),
  });
  if (!flip.response.ok) {
    throw new Error(`Enabling sidebar capabilities failed: HTTP ${flip.response.status} ${flip.text.slice(0, 500)}`);
  }

  await using browser = await chrome({
    name: "den-sidebar-ia",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before admin auth token handoff",
  });

  const adminTokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(den.admin.token)};
  })()`);
  expect(adminTokenStored).toBe(true);
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/org-settings`);
  await waitFor(browser, `Boolean(document.querySelector('[data-testid="den-org-sidebar"] [data-sidebar-section="manage"]'))
    && Boolean(document.querySelector('[data-testid="den-org-sidebar"] [data-sidebar-section="team"]'))
    && [...document.querySelectorAll('[data-testid="den-org-sidebar"] a')].some((link) => (link.textContent ?? "").includes("Tool Tester"))`, {
    timeoutMs: 60_000,
    label: "admin sidebar Manage section with Tool Tester under Settings",
  });

  const adminSections = parseSections(await evalIn(browser, readSidebar));
  const adminItems = itemNames(adminSections);
  const adminSectionNames = adminSections.map((section) => section.name);
  const adminHasMarketplace = adminItems.some((item) => item.includes("Collections"));
  const adminHasPluginDirectory = adminItems.some((item) => item.includes("Plugin Directory"));
  const adminHasConnectors = adminItems.some((item) => item.includes("Connectors") && item.includes("MCPs"));
  const adminHasWorkflowRuns = adminItems.some((item) => item.includes("Workflow Runs"));
  const adminChildren = adminSections.flatMap((section) => section.children);
  const adminHasToolTester = adminChildren.some((item) => item.includes("Tool Tester"));
  const adminHasTopLevelToolTester = adminItems.some((item) => item.includes("Tool Tester"));
  const adminHasExtensions = adminItems.some((item) => item === "Extensions" || item.startsWith("Extensions "));
  const adminHasYourConnections = adminItems.some((item) => item.includes("Your Connections"));
  const adminHasMyLibrary = adminItems.some((item) => item.includes("My Library"));
  const adminHasOpenWorkWeb = adminItems.some((item) => item.includes("OpenWork Web"));

  expect(adminSectionNames).toEqual(["work", "manage", "observability", "team"]);
  expect(adminHasMyLibrary).toBe(true);
  expect(adminHasMarketplace).toBe(true);
  expect(adminHasPluginDirectory).toBe(true);
  expect(adminHasConnectors).toBe(true);
  expect(adminHasWorkflowRuns).toBe(true);
  expect(adminHasToolTester).toBe(true);
  expect(adminHasTopLevelToolTester).toBe(false);
  expect(adminHasOpenWorkWeb).toBe(true);
  expect(adminHasExtensions).toBe(false);
  expect(adminHasYourConnections).toBe(false);
  evidence.fact(
    "The admin sidebar is sectioned into Work, Manage, Observability, and Team with the renamed destinations",
    `sections=${JSON.stringify(adminSectionNames)}; items=${JSON.stringify(adminItems)}; children=${JSON.stringify(adminChildren)}`,
    adminSectionNames.join(",") === "work,manage,observability,team"
      && adminHasMarketplace
      && adminHasPluginDirectory
      && adminHasConnectors
      && adminHasWorkflowRuns
      && adminHasToolTester
      && !adminHasTopLevelToolTester
      && !adminHasExtensions
      && !adminHasYourConnections,
  );

  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The left sidebar lists Work, Manage, Observability, and Team as section headings",
      "The sidebar includes My Library, Collections, Plugin Directory, Connectors, Workflow Runs, and Settings",
      "Tool Tester appears under Settings rather than as a top-level row",
      "The sidebar does not list Extensions or Your Connections as top-level rows",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const memberTokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(member.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(member.token)};
  })()`);
  expect(memberTokenStored).toBe(true);
  await navigate(browser.client, `${den.ref.webUrl}/dashboard/library`);
  await waitFor(browser, `Boolean(document.querySelector('[data-testid="den-org-sidebar"] [data-sidebar-section="work"]'))
    && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "My Library")`, {
    timeoutMs: 60_000,
    label: "member My Library with Work sidebar",
  });

  const memberSections = parseSections(await evalIn(browser, readSidebar));
  const memberItems = itemNames(memberSections);
  const memberSectionNames = memberSections.map((section) => section.name);
  const memberHasMarketplace = memberItems.some((item) => item.includes("Collections"));
  const memberHasWorkflowRuns = memberItems.some((item) => item.includes("Workflow Runs"));
  const memberHasPluginDirectory = memberItems.some((item) => item.includes("Plugin Directory"));
  const memberHasMyLibrary = memberItems.some((item) => item.includes("My Library"));

  expect(memberSectionNames).toEqual(["work"]);
  expect(memberHasMyLibrary).toBe(true);
  expect(memberHasMarketplace).toBe(false);
  expect(memberHasWorkflowRuns).toBe(false);
  expect(memberHasPluginDirectory).toBe(false);
  evidence.fact(
    "The member sidebar is Work only: My Library is present and Collections, Plugin Directory, and Workflow Runs are absent",
    `sections=${JSON.stringify(memberSectionNames)}; items=${JSON.stringify(memberItems)}`,
    memberSectionNames.join(",") === "work"
      && memberHasMyLibrary
      && !memberHasMarketplace
      && !memberHasWorkflowRuns
      && !memberHasPluginDirectory,
  );

  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The left sidebar shows a Work section with My Library and does not show Manage, Collections, or Workflow Runs",
      "The main page heading is My Library",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
});
