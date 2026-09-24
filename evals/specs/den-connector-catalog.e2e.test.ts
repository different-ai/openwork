import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { connectorCatalogManagement, isRecord, records } from "../worlds/library.ts";

const test = spec.world(connectorCatalogManagement, { timeout: 600_000 });

test("an admin sees the whole catalog, sets up Microsoft 365 on its own page, and account readiness stays personal", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const member = user.on(world.memberWeb);
  const page = probe.on(world.web);
  const base = `${world.den.ref.webUrl}/dashboard/mcp-connections`;
  const presetResponse = await probe.api(world.den.admin, "/v1/mcp-connections/presets");
  expect(presetResponse.response.ok).toBe(true);
  if (!isRecord(presetResponse.body)) throw new Error("Den returned no preset inventory.");
  const presets = records(presetResponse.body.presets);
  const presetNames = presets.map((entry) => String(entry.displayName));
  expect(presets.map((entry) => entry.presetId)).toEqual(expect.arrayContaining(["github", "notion", "slack", "context7", "exa"]));
  const before = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
  expect(before.response.ok).toBe(true);
  const authBefore = (await world.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token");
  const catalogRows = async () => (await page.dom('[data-testid^="connector-picker-"]')).elements.map((row) => row.text);

  await step("the add page lists every catalog connector plus Google Workspace and Microsoft 365", async () => {
    await admin.see({ role: "heading", label: "Add a connector" }, { timeoutMs: 90_000 });
    await admin.see({ role: "link", label: "Add Microsoft 365" }, { timeoutMs: 90_000 });
    // Google Workspace already has an older org client, so it opens instead of adding again.
    await admin.see({ role: "link", label: "Open Google Workspace" }, { timeoutMs: 60_000 });
    for (const name of presetNames) await admin.see({ role: "link", label: new RegExp(`^(Add|Open) ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });
    const rows = await catalogRows();
    expect(rows).toHaveLength(presetNames.length + 2);
    evidence.recordAssertionEvidence("the catalog shows every preset and both suites", `${rows.length} rows: Google Workspace, Microsoft 365 and ${presetNames.length} presets (${presetNames.join(", ")})`, true);
    await admin.screenshot();
  });

  await step("filtering narrows the list, and a name nobody offers leads to Add any MCP", async () => {
    await admin.type({ placeholder: "Filter by name, or paste an MCP URL" }, "granola");
    await eventually(async () => (await catalogRows()).length === 1, { within: 10_000, label: "one Granola row" });
    await admin.see({ role: "link", label: "Add Granola" });
    await admin.type({ placeholder: "Filter by name, or paste an MCP URL" }, "catalog-no-match", { replace: true });
    await admin.see({ testId: "connector-picker-no-match" }, { text: /No app called/ });
    await admin.see({ testId: "connector-picker-no-match-add" }, { text: "Add any MCP" });
    await admin.type({ placeholder: "Filter by name, or paste an MCP URL" }, "", { replace: true });
    const unchanged = (await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable")).body;
    expect(unchanged).toEqual(before.body);
    evidence.recordAssertionEvidence("filtering never changes connections", `"granola" leaves one row; "catalog-no-match" offers Add any MCP; connections unchanged`, true);
  });

  await step("Microsoft 365 is set up on its own page, and its connector page survives a reload", async () => {
    await admin.click({ role: "link", label: "Add Microsoft 365" });
    await admin.see({ role: "heading", label: "Add Microsoft 365" }, { timeoutMs: 60_000 });
    await admin.see({ testId: "native-provider-redirect-uri" }, { text: /\/v1\/oauth-providers\/microsoft-365\/connect\/callback/, timeoutMs: 60_000 });
    await admin.type({ testId: "native-provider-tenant-id" }, "11111111-1111-4111-8111-111111111111");
    await admin.type({ testId: "native-provider-client-id" }, "22222222-2222-4222-8222-222222222222");
    await admin.type({ testId: "native-provider-client-secret" }, "catalog-microsoft-test-secret");
    await admin.screenshot();
    await admin.click({ testId: "native-provider-save" });
    await eventually(async () => {
      const client = await probe.api(world.den.admin, "/v1/oauth-providers/microsoft-365/client");
      return isRecord(client.body) && client.body.configured === true;
    }, { within: 30_000, label: "Microsoft 365 setup to save" });
    await admin.see({ testId: "admin-connector-page" }, { timeoutMs: 60_000 });
    await admin.reload();
    await admin.see({ role: "heading", label: "Microsoft 365" }, { timeoutMs: 60_000 });
    await admin.see({ testId: "access-locked" }, { text: /Everyone in your organization/ });
    await admin.see({ role: "button", label: "Sign in" });
    await admin.click({ role: "button", label: "Settings" });
    await admin.see({ text: "22222222-2222-4222-8222-222222222222" });
    const usable = await probe.api(world.den.admin, "/v1/mcp-connections?scope=usable");
    const microsoft = isRecord(usable.body) ? records(usable.body.connections).find((entry) => entry.id === "microsoft-365") : undefined;
    expect(microsoft).toMatchObject({ connectedForMe: false, credentialMode: "per_member" });
    expect((await world.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token")).toEqual(authBefore);
    evidence.recordAssertionEvidence("Microsoft 365 saves on a full page and the admin still signs in for themselves", `Client configured; page shows "Everyone in your organization", a Sign in button and the saved client ID; connectedForMe=${String(microsoft?.connectedForMe)}`, true);
    await admin.screenshot();
  });

  await step("the older Google Workspace setup opens on its connector page, and its old link still lands there", async () => {
    await admin.navigate(`${base}/all/google-workspace`);
    await admin.see({ role: "heading", label: "Google Workspace" }, { timeoutMs: 60_000 });
    await admin.see({ testId: "admin-connector-page" });
    await admin.see({ role: "button", label: "Sign in" });
    evidence.recordAssertionEvidence("the old /all link lands on the Google Workspace connector page", `Opened ${base}/all/google-workspace and saw the Google Workspace connector page with Sign in`, true);
    await admin.screenshot();
  });

  await step("a new Google Workspace app saves on its own page with its selected permissions", async () => {
    await admin.navigate(`${base}/new/google-workspace`);
    await admin.see({ role: "heading", label: "Add Google Workspace" }, { timeoutMs: 60_000 });
    await admin.see({ testId: "native-provider-redirect-uri" }, { text: /\/connect\/callback/, timeoutMs: 60_000 });
    await admin.type({ label: "Name" }, "Workspace Documents", { replace: true });
    await admin.type({ testId: "native-provider-client-id" }, "workspace-test.apps.googleusercontent.com");
    await admin.type({ testId: "native-provider-client-secret" }, "catalog-google-test-secret");
    await admin.screenshot();
    await admin.click({ testId: "native-provider-save" });
    await admin.see({ role: "heading", label: "Workspace Documents" }, { timeoutMs: 60_000 });
    await admin.see({ testId: "admin-connector-page" });
    await admin.click({ role: "button", label: "Settings" });
    await admin.see({ text: "workspace-test.apps.googleusercontent.com" }, { timeoutMs: 60_000 });
    const result = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    const saved = isRecord(result.body) ? records(result.body.connections).find((entry) => entry.name === "Workspace Documents") : undefined;
    expect(saved).toMatchObject({ nativeProviderKey: "google-workspace", connectedForMe: false });
    expect((await world.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token")).toEqual(authBefore);
    evidence.recordAssertionEvidence("Google Workspace saves its own app without signing anyone in", `Connection ${String(saved?.id)} belongs to google-workspace; its settings show the saved client ID; connectedForMe=false`, true);
    await admin.screenshot();
  });

  await step("a member connects without making the admin personally connected", async () => {
    await member.see({ text: "Catalog Notes" }, { timeoutMs: 90_000 });
    await member.click({ testId: `connect-my-mcp-account-${world.connection.id}` });
    await member.see({ testId: `disconnect-my-mcp-account-${world.connection.id}` }, { timeoutMs: 120_000 });
    const memberState = await probe.api(world.den.members.member, "/v1/mcp-connections?scope=usable");
    if (!isRecord(memberState.body)) throw new Error("Den returned no member connections.");
    expect(records(memberState.body.connections).find((entry) => entry.id === world.connection.id)).toMatchObject({ connectedForMe: true });
    // The old configured link lands on the connector page.
    await admin.navigate(`${base}/configured?connectionId=${encodeURIComponent(world.connection.id)}`);
    await admin.see({ testId: "admin-connector-page" }, { timeoutMs: 60_000 });
    await admin.see({ role: "heading", label: "Catalog Notes" });
    await admin.see({ role: "button", label: "Sign in" });
    const adminState = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    if (!isRecord(adminState.body)) throw new Error("Den returned no admin connections.");
    expect(records(adminState.body.connections).find((entry) => entry.id === world.connection.id)).toMatchObject({ connectedForMe: false, connected: true });
    evidence.recordAssertionEvidence("the member's sign-in stays theirs", "Member connectedForMe=true; the admin's Catalog Notes page still offers Sign in (connectedForMe=false)", true);
    await admin.screenshot();
  });

  await step("the connector page edits settings in place", async () => {
    await admin.click({ role: "button", label: "Settings" });
    await admin.see({ testId: "connector-settings-name" }, { value: "Catalog Notes" });
    await admin.type({ testId: "connector-settings-name" }, "Catalog Notes Renamed", { replace: true });
    await admin.type({ testId: "connector-settings-scopes" }, "records.read records.write", { replace: true });
    // This connection registered an OAuth client when the member signed in.
    await admin.type({ label: "OAuth client ID" }, "catalog-settings-client", { replace: true });
    await admin.click({ role: "button", label: "Save changes" });
    await admin.see({ role: "heading", label: "Catalog Notes Renamed" }, { timeoutMs: 60_000 });
    const renamed = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    const row = isRecord(renamed.body) ? records(renamed.body.connections).find((entry) => entry.id === world.connection.id) : undefined;
    expect(row).toMatchObject({ name: "Catalog Notes Renamed", oauthClientId: "catalog-settings-client", requestedScopes: ["records.read", "records.write"] });
    await admin.click({ role: "button", label: "Review sign-in server" });
    await admin.see({ role: "button", label: "Save sign-in server" }, { timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("name, scopes and OAuth app save inline, and sign-in servers can be reviewed", `Den saved ${String(row?.name)}, client ${String(row?.oauthClientId)}, scopes ${JSON.stringify(row?.requestedScopes)}; the review offers Save sign-in server`, true);
    await admin.screenshot();
  });

  await step("a sign-in the provider rejects says so on the page, without a success notice", async () => {
    await admin.navigate(`${base}/${encodeURIComponent(world.rejectedConnection.id)}`);
    await admin.see({ role: "heading", label: "Catalog Recovery" }, { timeoutMs: 60_000 });
    const requestsBefore = (await world.rejected.requestLog()).length;
    const authRequests = (await world.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token");
    await admin.click({ role: "button", label: "Sign in" });
    await admin.see({ text: /Could not sign in to Catalog Recovery/ }, { timeoutMs: 60_000 });
    await admin.notSee({ testId: "den-toast" });
    const requests = (await world.rejected.requestLog()).slice(requestsBefore);
    expect(requests, "the provider endpoint receives the declared failure before authorization").toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/mcp", faulted: true, status: 503 }),
    ]));
    expect((await world.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token")).toEqual(authRequests);
    const state = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    if (!isRecord(state.body)) throw new Error("Den returned no connections after the failed sign-in.");
    expect(records(state.body.connections).find((entry) => entry.id === world.rejectedConnection.id)).toMatchObject({ connectedForMe: false, connected: false });
    evidence.recordAssertionEvidence("the rejection is reported inline and nothing is connected", `Provider answered 503 on /mcp; page reads "Could not sign in to Catalog Recovery"; connectedForMe=false`, true);
    await admin.screenshot();
  });
});
