import { queryDenDatabase, type Seed } from "@openwork/env";
import { adminActiveUsersSchema, adminDashboardSchema, adminOrganizationDetailSchema, adminOrganizationInsightsSchema, adminOrganizationUsageSchema } from "@openwork/types/den/admin-organization";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function adminOverviewWorld(seed: Seed) {
  const den = await seed.den({
    org: {
      name: "Overview workspace",
      admin: { name: "Overview Admin" },
      members: { member: { name: "Overview Member" } },
    },
  });
  const databaseUrl = den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Organization fixtures require a disposable testkit database.");
  const initial = await seed.api(den.admin, "/v1/org");
  if (!isRecord(initial.body) || !isRecord(initial.body.organization) || typeof initial.body.organization.id !== "string") throw new Error("Expected the seeded organization.");
  const organizationId = initial.body.organization.id;
  let foreignOrganizationId = "";
  let emptyOrganizationId = "";
  // A second page is a real boundary: seed 51 searchable records through the
  // product APIs instead of changing the UI's fixed 50-row page size.
  for (let value = 0; value < 51; value += 1) {
    const index = String(value).padStart(2, "0");
    const account = await fetch(`${den.ref.apiUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: den.ref.webUrl },
      body: JSON.stringify({ name: `Routing user ${index}`, email: `routing-user-${index}@example.test`, password: den.admin.password }),
    });
    if (!account.ok) throw new Error(`Routing account creation failed (${account.status}).`);
    const created: unknown = await account.json();
    if (!isRecord(created) || !isRecord(created.user) || typeof created.user.id !== "string") throw new Error("Expected a routing user.");
    await queryDenDatabase(databaseUrl, "INSERT INTO member (id, organization_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', NOW(3))", [`om_${String(value + 1).padStart(26, "0")}`, organizationId, created.user.id]);
    const organization = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: `Routing organization ${index}` }) });
    if (!organization.response.ok) throw new Error(`Routing organization creation failed (${organization.response.status}).`);
    if (value === 0 && isRecord(organization.body) && isRecord(organization.body.organization) && typeof organization.body.organization.id === "string") foreignOrganizationId = organization.body.organization.id;
    if (value === 1 && isRecord(organization.body) && isRecord(organization.body.organization) && typeof organization.body.organization.id === "string") emptyOrganizationId = organization.body.organization.id;
  }
  const plan = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/plan`, { method: "PATCH", body: JSON.stringify({ tier: "free", seatLimit: 100 }) });
  if (!plan.response.ok) throw new Error("Could not size the fixture organization for its member pages.");
  // Recorded and retained rows are setup only; assertions read the product API.
  // The isolated fixture includes missing accounting, a removed member, and
  // another organization so zero usage and scope leaks cannot satisfy the test.
  const memberId = `om_${"1".padStart(26, "0")}`;
  const removedId = `om_${"99".padStart(26, "0")}`;
  await queryDenDatabase(databaseUrl, "INSERT INTO member (id, organization_id, role, removed_at) VALUES (?, ?, 'member', NOW(3))", [removedId, organizationId]);
  const insertRaw = async (index: number, org: string, member: string, tokens: number | null, price: number | null) => queryDenDatabase(databaseUrl,
    "INSERT INTO gateway_request_logs (id, organization_id, org_membership_id, route, protocol, upstream_provider_id, upstream_host, upstream_path, method, stream, outcome, usage_source, openwork_request_id, total_tokens, cost_micro_usd, started_at, completed_at) VALUES (?, ?, ?, 'org_provider', 'openai_chat', 'fixture', 'example.test', '/chat/completions', 'POST', 0, 'ok', 'json', ?, ?, ?, NOW(3), NOW(3))",
    [`irl_${String(index).padStart(26, "0")}`, org, member, `admin-organization-${index}`, tokens, price]);
  await insertRaw(1, organizationId, memberId, 120, 1_250_000);
  await insertRaw(2, organizationId, memberId, null, null);
  await insertRaw(3, organizationId, removedId, 50, 250_000);
  if (!foreignOrganizationId) throw new Error("Expected a second organization.");
  const foreignMembers = await queryDenDatabase(databaseUrl, "SELECT id FROM member WHERE organization_id = ? LIMIT 1", [foreignOrganizationId]);
  if (!isRecord(foreignMembers[0]) || typeof foreignMembers[0].id !== "string") throw new Error("Expected a member in the other organization.");
  await insertRaw(4, foreignOrganizationId, foreignMembers[0].id, 9999, 99_000_000);
  const unpricedId = `om_${"2".padStart(26, "0")}`;
  await insertRaw(5, organizationId, unpricedId, 20, null);
  await queryDenDatabase(databaseUrl, "INSERT INTO gateway_usage_rollups (id, granularity, bucket_start, dimension_key, organization_id, org_membership_id, route, protocol, upstream_provider_id, request_count, ok_count, total_tokens, total_tokens_count, cost_micro_usd, cost_count) VALUES (?, 'day', DATE_SUB(UTC_DATE(), INTERVAL 3 DAY), 'admin-organization-legacy', ?, ?, 'org_provider', 'openai_chat', 'fixture', 1, 1, 0, NULL, 0, NULL)", [`iur_${"2".padStart(26, "0")}`, organizationId, unpricedId]);
  await queryDenDatabase(databaseUrl, "INSERT INTO gateway_usage_rollups (id, granularity, bucket_start, dimension_key, organization_id, org_membership_id, route, protocol, upstream_provider_id, request_count, ok_count, total_tokens, total_tokens_count, cost_micro_usd, cost_count) VALUES (?, 'day', DATE_SUB(UTC_DATE(), INTERVAL 2 DAY), 'admin-organization-retained', ?, ?, 'org_provider', 'openai_chat', 'fixture', 2, 2, 80, 2, 500000, 2)", [`iur_${"1".padStart(26, "0")}`, organizationId, memberId]);
  await queryDenDatabase(databaseUrl, "UPDATE gateway_request_logs SET upstream_model = CASE WHEN openwork_request_id IN ('admin-organization-1', 'admin-organization-3') THEN 'test-active-model' ELSE 'test-secondary-model' END WHERE organization_id = ?", [organizationId]);
  await queryDenDatabase(databaseUrl, "UPDATE gateway_usage_rollups SET upstream_model = 'test-active-model' WHERE dimension_key = 'admin-organization-retained' AND organization_id = ?", [organizationId]);
  await queryDenDatabase(databaseUrl, "INSERT INTO gateway_usage_rollups (id, granularity, bucket_start, dimension_key, organization_id, org_membership_id, route, protocol, upstream_provider_id, upstream_model, request_count, ok_count, total_tokens, total_tokens_count, cost_micro_usd, cost_count) VALUES (?, 'day', DATE_SUB(UTC_DATE(), INTERVAL 40 DAY), 'admin-organization-prior', ?, ?, 'org_provider', 'openai_chat', 'fixture', 'previous-period-model', 3, 3, 300, 3, 750000, 3)", [`iur_${"3".padStart(26, "0")}`, organizationId, memberId]);
  await queryDenDatabase(databaseUrl, "INSERT INTO gateway_usage_rollups (id, granularity, bucket_start, dimension_key, organization_id, org_membership_id, route, protocol, upstream_provider_id, upstream_model, request_count, ok_count, total_tokens, total_tokens_count, cost_micro_usd, cost_count) VALUES (?, 'day', DATE_SUB(UTC_DATE(), INTERVAL 70 DAY), 'admin-organization-outside', ?, ?, 'org_provider', 'openai_chat', 'fixture', 'outside-window-model', 100, 100, 10000, 100, 90000000, 100)", [`iur_${"4".padStart(26, "0")}`, organizationId, memberId]);
  const overrides = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT", body: JSON.stringify({ capabilities: { slackAssistant: false, slackWorkbotReplies: true, workbot: true } }),
  });
  if (!overrides.response.ok) throw new Error("Could not set up organization feature overrides.");
  const killed = await seed.api(den.admin, "/v1/admin/features/appBuildProgress", { method: "PUT", body: JSON.stringify({ killed: true }) });
  if (!killed.response.ok) throw new Error("Could not set up a globally disabled feature.");
  const viewport = { width: 1280, height: 700 };
  const anonymous = await seed.web({ den, startPath: "/admin/users?search=Routing&page=2", headless: true, viewport });
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: "/admin/users", headless: true, viewport: { width: 1280, height: 200 } });
  const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/admin/organizations", headless: true, viewport });
  return {
    anonymous, admin, member, organizationId, memberId,
    detailPath: `/admin/organizations/${organizationId}`,
    emptyDetailPath: `/admin/organizations/${emptyOrganizationId}`,
    unpricedMemberId: unpricedId,
    async featureState(key: string, foreign = false) {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${foreign ? foreignOrganizationId : organizationId}/capabilities`);
      if (!result.response.ok || !isRecord(result.body) || !isRecord(result.body.featureStates)) throw new Error("Could not read organization features.");
      const state = result.body.featureStates[key];
      if (!isRecord(state)) throw new Error(`Missing feature state for ${key}.`);
      return state;
    },
    async organizationMembers(query = "") {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}?${query}`);
      if (!result.response.ok) throw new Error(`Organization members failed (${result.response.status}).`);
      return adminOrganizationDetailSchema.parse(result.body);
    },
    async organizationUsage(query = "") {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/usage?${query}`);
      if (!result.response.ok) throw new Error(`Organization usage failed (${result.response.status}).`);
      return adminOrganizationUsageSchema.parse(result.body);
    },
    async dashboard() {
      const result = await seed.api(den.admin, "/v1/admin/dashboard");
      if (!result.response.ok) throw new Error(`Dashboard failed (${result.response.status}).`);
      return adminDashboardSchema.parse(result.body);
    },
    async activeUsers() {
      const result = await seed.api(den.admin, "/v1/admin/dashboard/active-users");
      if (!result.response.ok) throw new Error(`Active users failed (${result.response.status}).`);
      return adminActiveUsersSchema.parse(result.body);
    },
    async activeUsersAccess() {
      return (await seed.api(den.members.member, "/v1/admin/dashboard/active-users")).response.status;
    },
    async dashboardAccess() {
      return (await seed.api(den.members.member, "/v1/admin/dashboard")).response.status;
    },
    async organizationInsights() {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/insights?limit=1`);
      if (!result.response.ok) throw new Error(`Organization insights failed (${result.response.status}).`);
      return adminOrganizationInsightsSchema.parse(result.body);
    },
    async organizationAccess() {
      return {
        member: (await seed.api(den.members.member, `/v1/admin/organizations/${organizationId}`)).response.status,
        memberFeatures: (await seed.api(den.members.member, `/v1/admin/organizations/${organizationId}/capabilities`)).response.status,
        memberInsights: (await seed.api(den.members.member, `/v1/admin/organizations/${organizationId}/insights`)).response.status,
        memberUsage: (await seed.api(den.members.member, `/v1/admin/organizations/${organizationId}/usage`)).response.status,
        missing: (await seed.api(den.admin, `/v1/admin/organizations/org_${"0".repeat(26)}`)).response.status,
        invalid: (await seed.api(den.admin, "/v1/admin/organizations/invalid")).response.status,
      };
    },
    url(path: string) { return new URL(path, den.ref.webUrl).toString(); },
    async location() {
      // TODO(primitive): probe.hash omits URL search; navigation needs a
      // read-only projection of the pathname, search state and active link.
      return seed.evalIn(admin, () => {
        const params = new URLSearchParams(location.search);
        return { pathname: location.pathname, search: params.get("search") ?? "", page: Number(params.get("page") ?? "1"), active: document.querySelector('[data-testid="admin-navigation"] [aria-current]')?.textContent?.trim() };
      });
    },
    async history(direction: "back" | "forward") {
      // TODO(primitive): user needs browser back/forward. Exercise Chromium's
      // real navigation history, without writing application or fixture state.
      const history = await admin.client.send("Page.getNavigationHistory");
      if (!isRecord(history) || !Array.isArray(history.entries) || typeof history.currentIndex !== "number") throw new Error("Browser history was unavailable.");
      const entry = history.entries[history.currentIndex + (direction === "back" ? -1 : 1)];
      if (!isRecord(entry) || typeof entry.id !== "number") throw new Error("The expected browser history entry is missing.");
      await admin.client.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    },
    async firstRow(section: "users" | "organizations", search: string, page: number) {
      const query = new URLSearchParams({ search, limit: "50", offset: String((page - 1) * 50) });
      if (section === "organizations") query.set("includeFeatures", "0");
      const result = await seed.api(den.admin, `/v1/admin/${section}?${query}`);
      if (!result.response.ok || !isRecord(result.body) || !Array.isArray(result.body[section])) throw new Error("Could not read the expected list page.");
      const first = result.body[section][0];
      if (!isRecord(first)) throw new Error("The expected list page was empty.");
      return section === "users" ? `admin-user-row-${first.id}` : `admin-org-row-${first.slug}`;
    },
    async traffic(person: "anonymous" | "admin" | "member") {
      const web = person === "anonymous" ? anonymous : person === "admin" ? admin : member;
      // TODO(primitive): probe needs a read-only resource timing projection to
      // prove the absence of eager requests without injecting product state.
      return seed.evalIn(web, () => {
        // Development Strict Mode can abort its initial read before a response.
        // Count completed responses, which correspond to data the page received.
        const resources = performance.getEntriesByType("resource").filter((entry) =>
          "responseStatus" in entry && typeof entry.responseStatus === "number" && entry.responseStatus > 0,
        );
        return {
          users: resources.filter((entry) => new URL(entry.name).pathname.endsWith("/admin/users")).length,
          overview: resources.filter((entry) => new URL(entry.name).pathname.endsWith("/admin/overview")).length,
          usage: resources.filter((entry) => new URL(entry.name).pathname.endsWith("/inference-usage")).length,
          dashboard: resources.filter((entry) => new URL(entry.name).pathname.endsWith("/admin/dashboard")).length,
          activeUsers: resources.filter((entry) => new URL(entry.name).pathname.endsWith("/admin/dashboard/active-users")).length,
          metrics: resources.filter((entry) => new URL(entry.name).pathname.endsWith("/admin/metrics")).length,
          organizationInsights: resources.filter((entry) => /\/v1\/admin\/organizations\/[^/]+\/insights$/.test(new URL(entry.name).pathname)).length,
          organizationUsage: resources.filter((entry) => /\/v1\/admin\/organizations\/[^/]+\/usage$/.test(new URL(entry.name).pathname)).length,
          organizationDetail: resources.filter((entry) => /\/v1\/admin\/organizations\/[^/]+$/.test(new URL(entry.name).pathname)).length,
          features: resources.filter((entry) => /\/admin\/organizations\/[^/]+\/capabilities$/.test(new URL(entry.name).pathname)).length,
          lightOrganizations: resources.filter((entry) => {
            const url = new URL(entry.name);
            return url.pathname.endsWith("/admin/organizations") && url.searchParams.get("includeFeatures") === "0";
          }).length,
        };
      });
    },
    async organizationPayloads() {
      const full = await seed.api(den.admin, "/v1/admin/organizations");
      const light = await seed.api(den.admin, "/v1/admin/organizations?includeFeatures=0");
      if (!full.response.ok || !light.response.ok) throw new Error("Could not read admin organization pages.");
      const rows = (value: unknown): Record<string, unknown>[] => {
        if (!value || typeof value !== "object" || !("organizations" in value) || !Array.isArray(value.organizations)) return [];
        return value.organizations.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
      };
      const fullRows = rows(full.body);
      const lightRows = rows(light.body);
      return {
        fullCount: fullRows.length,
        lightCount: lightRows.length,
        fullWithFeatures: fullRows.filter((row) => "capabilities" in row && "featureStates" in row).length,
        lightWithFeatures: lightRows.filter((row) => "capabilities" in row || "featureStates" in row).length,
        fullBytes: full.text.length,
        lightBytes: light.text.length,
      };
    },
  };
}
