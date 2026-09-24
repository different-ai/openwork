import { createHash } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denManageAsAdmin } from "../worlds/den-library-manage.ts";
import { isRecord, records } from "../worlds/library.ts";

// Admins add a connector once in Manage and choose who gets it. Every add
// happens on full pages: the catalog, the setup checks, then who can use it.
const test = spec.world(denManageAsAdmin, { timeout: 600_000 });

const names = (items: { name: string }[]) => items.map((item) => item.name);
const addPath = "/dashboard/mcp-connections/new";

test("an admin adds a listed connector for two teams", async ({ world, user, probe, step, evidence }) => {
  const reach = world.teamSize("Sales") + world.teamSize("Support");

  await step("1. I open Connectors in Manage: nothing is set up yet", async () => {
    await user.see({ testId: "connectors-empty" }, { timeoutMs: 120_000 });
    await user.see({ text: "Apps your organization's AI can use. You choose who gets each one." });
    await user.see({ text: "Members can still add apps for themselves in My Library." });
    const links = await probe.eventually(() => world.sidebarLinks(), {
      within: 30_000, label: "admin sidebar", until: (labels) => labels.some((label) => label.startsWith("Connectors")),
    });
    for (const label of ["My Library", "Plugins", "Members"]) expect(links).toContain(label);
    expect(links).toContain("ConnectorsMCPs");
    const badges = (await probe.dom('[data-testid="den-org-sidebar"] a[href$="/mcp-connections"] [data-testid="nav-badge"]')).elements.map((badge) => badge.text);
    expect(badges).toEqual(["MCPs"]);
    evidence.recordAssertionEvidence("the Connectors sidebar item keeps its MCPs badge, in its own casing", `Sidebar links: ${links.join(", ")}; badge text: ${badges.join(", ")}`, true);
    await user.screenshot();
  });

  await step("the MCPs badge remains visible when Connectors is not selected", async () => {
    await user.navigate(`${world.den.ref.webUrl}/dashboard/plugins`);
    await user.see({ role: "heading", label: "Plugins" }, { timeoutMs: 60_000 });
    const badges = (await probe.dom('[data-testid="den-org-sidebar"] a[href$="/mcp-connections"] [data-testid="nav-badge"]')).elements.map((badge) => badge.text);
    expect(badges).toEqual(["MCPs"]);
    evidence.recordAssertionEvidence("the badge stays on the Connectors item from another page", `On Plugins, the Connectors badge reads ${badges.join(", ")}`, true);
    await user.screenshot();
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections`);
    await user.see({ testId: "connectors-empty" }, { timeoutMs: 60_000 });
  });

  await step("2. I choose Add connector and pick Slack", async () => {
    await user.click({ role: "link", label: "Add connector" });
    await user.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 60_000 });
    await user.click({ role: "link", label: "Add Slack" });
    await user.see({ role: "heading", label: "Add Slack" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: "Sign in with Slack" }, { timeoutMs: 60_000 });
    const pinned = await world.servedPinnedCatalog();
    expect(pinned, "the catalog and checks came from the mock, not a real provider").toBe(true);
    evidence.recordAssertionEvidence("Slack's setup page asks me to sign in", `Setup checks reached "Sign in with Slack"; catalog and discovery served by the local mock: ${pinned}`, pinned);
    await user.screenshot();
  });

  await step("3. I sign in with Slack once to try it", async () => {
    await user.click({ role: "button", label: "Sign in with Slack" });
    await user.see({ role: "heading", label: "Slack passed all 4 checks" }, { timeoutMs: 120_000 });
    await world.closeSignInTab();
    await user.see({ role: "radio", label: /Each person signs in/ });
    const chosen = await probe.dom('input[name="sign-in-mode"][value="per_member"]:checked');
    expect(chosen.elements, "each person signs in is the default").toHaveLength(1);
    evidence.recordAssertionEvidence("after signing in, Slack passes all four checks and each person signs in by default", `"Slack passed all 4 checks"; checked sign-in radios: ${chosen.elements.length}`, true);
    await user.screenshot();
  });

  await step("4. I let each person sign in and give it to Sales and Support", async () => {
    for (const team of ["Sales", "Support"]) {
      await user.click({ role: "button", label: "Add team" });
      await user.click({ role: "option", label: new RegExp(team) });
      await user.click({ role: "button", label: `Add ${team}` });
    }
    await user.see({ testId: "step-footer-note" }, { text: `${reach} people will find Slack in My Library.` });
    evidence.recordAssertionEvidence("the footer counts who Slack will reach", `${reach} people will find Slack in My Library.`, true);
    await user.screenshot();
  });

  await step("5. I add Slack and see who has it", async () => {
    await user.click({ role: "button", label: "Add Slack" });
    await user.see({ testId: "den-toast" }, { text: /Slack is ready/, timeoutMs: 60_000 });
    await user.see({ testId: "den-toast" }, { text: new RegExp(`${reach} people will find it in My Library\\.`) });
    await user.see({ testId: "admin-connectors" }, { text: /Sales and Support/, timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("the list shows Slack with Sales and Support", `Toast "Slack is ready"; list row reads Sales and Support`, true);
    await user.screenshot();
  });

  await step("6. I open Slack: who can use it sits on the page instead of a Share button", async () => {
    await user.click({ role: "link", label: /^Slack/ });
    await user.see({ testId: "admin-connector-page" }, { timeoutMs: 60_000 });
    await user.see({ text: "Each person signs in with their own Slack account" });
    const teamRows = await probe.dom('[data-testid="access-team"]');
    const teams = teamRows.elements.map((row) => /^(Sales|Support)/.exec(row.text)?.[1]).sort();
    expect(teams, "both teams sit in Who can use it").toEqual(["Sales", "Support"]);
    await user.notSee({ role: "link", label: "Share" });
    await user.see({ role: "button", label: "Use in another app" });
    await user.see({ role: "button", label: "Settings" });
    evidence.recordAssertionEvidence("Slack's page lists both teams and keeps its settings inline", `Who can use it: ${teams.join(", ")}; no Share link; Settings is on the page`, true);
    await user.screenshot();
  });

  await step("after: everyone in Sales and Support finds Slack in My Library and signs in as themselves, and Kai, who is in neither team, does not", async () => {
    for (const person of ["omar", "tess", "ana", "lee", "noor"] as const) {
      expect(names(await world.library(world.den.members[person])), `${person} has Slack`).toContain("Slack");
      const usable = await probe.api(world.den.members[person], "/v1/mcp-connections?scope=usable");
      const slack = isRecord(usable.body) ? records(usable.body.connections).find((entry) => entry.name === "Slack") : undefined;
      expect(slack?.credentialMode, `${person} signs in with their own account`).toBe("per_member");
    }
    const kai = names(await world.library(world.den.members.kai));
    expect(kai, "Kai is in neither team").not.toContain("Slack");
    evidence.recordAssertionEvidence("Sales and Support have Slack; Kai does not", `Omar, Tess, Ana, Lee and Noor have Slack (per person sign-in); Kai's Library: ${kai.join(", ") || "empty"}`, true);
    await user.screenshot();
  });
});

test("an admin: I want to add an MCP that isn't in the catalog", async ({ world, user, probe, step, evidence }) => {
  const address = world.custom.mcpUrl;
  const host = new URL(address).host;
  const name = "Team Notes";

  await step("before: the add page lists known connectors with Google Workspace and Microsoft 365, and a quiet Add any MCP", async () => {
    await user.navigate(`${world.den.ref.webUrl}${addPath}`);
    await user.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 60_000 });
    await user.see({ role: "link", label: "Add HubSpot" }, { timeoutMs: 60_000 });
    await user.see({ role: "link", label: "Add Google Workspace" });
    await user.see({ role: "link", label: "Add Microsoft 365" });
    await user.see({ testId: "add-any-mcp" }, { text: "Add any MCP" });
    await user.notSee({ text: /Advanced setup/ });
    await user.see({ placeholder: "Filter by name, or paste an MCP URL" });
    evidence.recordAssertionEvidence("the catalog offers the native suites and Add any MCP without an advanced editor", "Rows: HubSpot, Google Workspace, Microsoft 365; header action \"Add any MCP\"; no \"Advanced setup\" link", true);
    await user.screenshot();
  });

  await step("when I paste an address into the filter, it shows up as an MCP server to add", async () => {
    await user.type({ placeholder: "Filter by name, or paste an MCP URL" }, address);
    await user.see({ testId: "connector-picker-url-row" }, { text: new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await user.see({ testId: "connector-picker-url-row" }, { text: /MCP server/ });
    await user.see({ testId: "connector-picker-url-add" }, { text: "Add MCP" });
    await user.see({ testId: "connector-picker-url-no-match" }, { text: "No catalog connectors match this address." });
    await user.notSee({ testId: "connector-picker-no-match" });
    evidence.recordAssertionEvidence("a pasted address becomes the top row with Add MCP", `Filter "${address}" shows "${host} · MCP server" with Add MCP, and "No catalog connectors match this address."`, true);
    await user.screenshot();
    await user.type({ placeholder: "Filter by name, or paste an MCP URL" }, "", { replace: true });
  });

  await step("Add any MCP opens the address form on the same page", async () => {
    await user.click({ testId: "add-any-mcp" });
    await user.see({ testId: "connector-picker-custom" }, { timeoutMs: 30_000 });
    await user.notSee({ testId: "add-mcp-connection-dialog" });
    const location = await world.location();
    expect(location).toBe(addPath);
    await user.type({ label: "Address" }, address);
    await user.type({ label: "Name" }, name);
    evidence.recordAssertionEvidence("the form opens in place, with no dialog and no page change", `Location stayed ${location}; address and name typed into the inline form`, true);
    await user.screenshot();
  });

  await step("then the setup page checks the server and I sign in once to try it", async () => {
    await user.click({ role: "button", label: "Continue" });
    await user.see({ role: "heading", label: `Add ${name}` }, { timeoutMs: 60_000 });
    const location = await world.location();
    const setupUrl = new URL(location, world.den.ref.webUrl);
    expect(setupUrl.pathname).toBe(`${addPath}/custom`);
    expect(setupUrl.searchParams.get("url")).toBe(address);
    await user.see({ role: "button", label: `Sign in with ${name}` }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: `Sign in with ${name}` });
    await user.see({ role: "heading", label: `${name} passed all 4 checks` }, { timeoutMs: 120_000 });
    await world.closeSignInTab();
    evidence.recordAssertionEvidence("the address reaches the full-page checks and passes all four", `Setup page ${setupUrl.pathname}?url=${address}; "${name} passed all 4 checks"`, true);
    await user.screenshot();
  });

  await step("I give it to Support and add it", async () => {
    await user.click({ role: "button", label: "Add team" });
    await user.click({ role: "option", label: /Support/ });
    await user.click({ role: "button", label: "Add Support" });
    await user.see({ testId: "step-footer-note" }, { text: `${world.teamSize("Support")} people will find ${name} in My Library.` });
    await user.click({ role: "button", label: `Add ${name}` });
    await user.see({ testId: "den-toast" }, { text: new RegExp(`${name} is ready`), timeoutMs: 60_000 });
    await user.see({ testId: "admin-connectors" }, { text: /Support/, timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("the MCP is added for Support", `Toast "${name} is ready"; the list shows it with Support`, true);
    await user.screenshot();
  });

  await step("after: Support finds it in My Library, and Sales and Kai, who are not in Support, do not", async () => {
    const saved = await probe.eventually(async () => {
      const manageable = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
      return isRecord(manageable.body) ? records(manageable.body.connections).find((entry) => entry.url === address) : undefined;
    }, { within: 60_000, label: "the MCP to be saved" });
    expect(saved?.name).toBe(name);
    for (const person of ["ana", "lee", "noor"] as const) {
      expect(names(await world.library(world.den.members[person])), `${person} is in Support`).toContain(name);
    }
    const outside = await Promise.all((["omar", "tess", "kai"] as const).map(async (person) => ({ person, has: names(await world.library(world.den.members[person])).includes(name) })));
    expect(outside.filter((entry) => entry.has)).toEqual([]);
    evidence.recordAssertionEvidence("only Support gets the MCP", `Saved "${String(saved?.name)}" at ${address}; Ana, Lee and Noor have it; ${outside.map((entry) => `${entry.person}: ${entry.has ? "has it" : "no"}`).join(", ")}`, true);
    await user.screenshot();
  });
});

test("an admin adds a connector that takes an API key, and a member sees that only an admin can", async ({ world, user, probe, step, evidence }) => {
  const key = `keyed-docs-${Date.now()}`;
  const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 12);

  await step("before: a member adding it in My Library sees that an admin adds the key", async () => {
    const member = await world.openAs("sam", "/dashboard/library/connectors/new/keyed-docs");
    const sam = user.on(member);
    await sam.see({ role: "heading", label: "Connect Keyed Docs" }, { timeoutMs: 90_000 });
    await sam.see({ testId: "setup-check-sign-in-method" }, { text: /An admin adds the key for Keyed Docs\./, timeoutMs: 60_000 });
    const blocked = await probe.on(member).dom('[data-testid="setup-check-sign-in-method"][data-status="blocked"]');
    expect(blocked.elements).toHaveLength(1);
    await sam.notSee({ label: "API key" });
    evidence.recordAssertionEvidence("the member's step two is blocked, not failed", `Step two reads "An admin adds the key for Keyed Docs." with status blocked; no key field`, true);
    await sam.screenshot();
  });

  await step("when I add it in Manage, step two asks for the key instead of failing", async () => {
    await user.navigate(`${world.den.ref.webUrl}${addPath}`);
    await user.click({ role: "link", label: "Add Keyed Docs" });
    await user.see({ role: "heading", label: "Add Keyed Docs" }, { timeoutMs: 60_000 });
    await user.see({ label: "API key" }, { timeoutMs: 60_000 });
    const current = await probe.dom('[data-testid="setup-check-sign-in-method"][data-status="current"]');
    expect(current.elements).toHaveLength(1);
    await user.notSee({ role: "button", label: "Sign in with Keyed Docs" });
    evidence.recordAssertionEvidence("step two shows an API key field for the admin", `Step two is current and reads "${current.elements[0]?.text ?? ""}"; no sign-in button`, true);
    await user.screenshot();
  });

  await step("I paste the key and every check passes", async () => {
    await user.type({ label: "API key" }, key);
    await user.click({ role: "button", label: "Save key" });
    await user.see({ role: "heading", label: "Keyed Docs passed all 4 checks" }, { timeoutMs: 120_000 });
    await user.see({ text: "A key cannot sign people in one by one" });
    const shared = await probe.dom('input[name="sign-in-mode"][value="shared"]:checked:disabled');
    expect(shared.elements).toHaveLength(1);
    const manageable = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    const saved = isRecord(manageable.body) ? records(manageable.body.connections).find((entry) => entry.name === "Keyed Docs") : undefined;
    expect(saved).toMatchObject({ authType: "apikey", credentialMode: "shared" });
    evidence.recordAssertionEvidence("the key is saved for everyone and per-person sign-in is off with a reason", `Saved Keyed Docs as authType=${String(saved?.authType)}, credentialMode=${String(saved?.credentialMode)}; "One account for everyone" is checked and locked`, true);
    await user.screenshot();
  });

  await step("then Keyed Docs really received that key", async () => {
    const calls = await probe.eventually(async () => (await world.keyed.requests()).filter((entry) => entry.path === "/mcp" && entry.tokenId === fingerprint), {
      within: 30_000, label: "the key to reach the server", until: (entries) => entries.length > 0,
    });
    evidence.recordAssertionEvidence("the server was called with the admin's key", `${calls.length} MCP request(s) carried the key's fingerprint ${fingerprint}`, calls.length > 0);
    expect(calls.length).toBeGreaterThan(0);
    await user.see({ role: "heading", label: "Keyed Docs passed all 4 checks" });
  });

  await step("after: I give it to Sales; Sales gets it and Kai does not", async () => {
    await user.click({ role: "button", label: "Add team" });
    await user.click({ role: "option", label: /Sales/ });
    await user.click({ role: "button", label: "Add Sales" });
    await user.click({ role: "button", label: "Add Keyed Docs" });
    await user.see({ testId: "den-toast" }, { text: /Keyed Docs is ready/, timeoutMs: 60_000 });
    for (const person of ["omar", "tess"] as const) {
      expect(names(await world.library(world.den.members[person])), `${person} is in Sales`).toContain("Keyed Docs");
    }
    const kai = names(await world.library(world.den.members.kai));
    expect(kai).not.toContain("Keyed Docs");
    evidence.recordAssertionEvidence("Sales has Keyed Docs and Kai does not", `Omar and Tess have Keyed Docs; Kai's Library: ${kai.join(", ") || "empty"}`, true);
    await user.screenshot();
  });
  await step("the admin can rotate the shared key from the connector's own page", async () => {
    const response = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    const saved = isRecord(response.body) ? records(response.body.connections).find((entry) => entry.name === "Keyed Docs") : undefined;
    if (!saved || typeof saved.id !== "string") throw new Error("Keyed Docs was not saved.");
    await user.navigate(`${world.den.ref.webUrl}/dashboard/mcp-connections/${encodeURIComponent(saved.id)}`);
    await user.see({ role: "heading", label: "Keyed Docs" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Settings" });
    await user.type({ testId: "connector-settings-api-key" }, "rotated-shared-test-key");
    await user.click({ role: "button", label: "Save changes" });
    await user.see({ testId: "den-toast" }, { text: /Keyed Docs is saved/, timeoutMs: 60_000 });
    await user.see({ testId: "connector-settings-api-key" }, { value: "" });
    const rotated = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    const connection = isRecord(rotated.body) ? records(rotated.body.connections).find((entry) => entry.id === saved.id) : undefined;
    expect(connection).toMatchObject({ authType: "apikey", credentialMode: "shared" });
    expect(JSON.stringify(rotated.body)).not.toContain("rotated-shared-test-key");
    evidence.recordAssertionEvidence("key rotation saves inline and never returns the secret", "Keyed Docs remains shared; the replacement field is empty after save, and the connection response contains no replacement key", true);
    await user.screenshot();
  });
});

test("an admin adds a connector that needs their own OAuth app", async ({ world, user, probe, step, evidence }) => {
  const clientId = "team-wiki-client";

  await step("before: step two asks for the OAuth app instead of trying to sign in", async () => {
    await user.navigate(`${world.den.ref.webUrl}${addPath}`);
    await user.click({ role: "link", label: "Add Team Wiki" });
    await user.see({ role: "heading", label: "Add Team Wiki" }, { timeoutMs: 60_000 });
    await user.see({ label: "Client ID" }, { timeoutMs: 60_000 });
    await user.see({ placeholder: "Client secret (optional)" });
    await user.notSee({ role: "button", label: "Sign in with Team Wiki" });
    evidence.recordAssertionEvidence("step two shows the OAuth app fields", "Client ID and an optional client secret; no sign-in button yet", true);
    await user.screenshot();
  });

  await step("when I save the app, sign-in uses it and every check passes", async () => {
    await user.type({ label: "Client ID" }, clientId);
    await user.click({ role: "button", label: "Save app" });
    await user.see({ role: "button", label: "Sign in with Team Wiki" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Sign in with Team Wiki" });
    await user.see({ role: "heading", label: "Team Wiki passed all 4 checks" }, { timeoutMs: 120_000 });
    await world.closeSignInTab();
    const authorize = (await world.wiki.requests()).filter((entry) => entry.path === "/authorize");
    const usedApp = authorize.some((entry) => new URL(entry.url, "http://mock.invalid").searchParams.get("client_id") === clientId);
    expect(usedApp, "sign-in used the admin's OAuth app").toBe(true);
    evidence.recordAssertionEvidence("sign-in went through the admin's OAuth app", `${authorize.length} authorize request(s); client_id=${clientId}: ${usedApp}`, usedApp);
    await user.screenshot();
  });

  await step("after: I add it for Support and the saved connection keeps the OAuth app", async () => {
    await user.click({ role: "button", label: "Add team" });
    await user.click({ role: "option", label: /Support/ });
    await user.click({ role: "button", label: "Add Support" });
    await user.click({ role: "button", label: "Add Team Wiki" });
    await user.see({ testId: "den-toast" }, { text: /Team Wiki is ready/, timeoutMs: 60_000 });
    const manageable = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    const saved = isRecord(manageable.body) ? records(manageable.body.connections).find((entry) => entry.name === "Team Wiki") : undefined;
    expect(saved).toMatchObject({ authType: "oauth", oauthClientId: clientId });
    const kai = names(await world.library(world.den.members.kai));
    expect(kai).not.toContain("Team Wiki");
    evidence.recordAssertionEvidence("Team Wiki is saved with the admin's app, for Support only", `oauthClientId=${String(saved?.oauthClientId)}; Kai's Library: ${kai.join(", ") || "empty"}`, true);
    await user.screenshot();
  });
});
