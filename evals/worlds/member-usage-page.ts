import { queryDenDatabase, type Seed } from "@openwork/env";
import { gatewayMemberUsageResponseSchema } from "@openwork/types/den/gateway-member-usage";
import { gatewayUsageLimitPolicySchema, gatewayUsagePeriod, gatewayUsageStatusSchema } from "@openwork/types/den/gateway-usage-limits";
import { isRecord } from "./library.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

/** Models the provider offers; the public catalog lists a price for each. */
export const MEMBER_USAGE_MODELS = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-5-5"] as const;
/** What the member's seeded requests cost at the catalog's listed prices, in micro-USD: four Sonnet requests and one Opus request. */
export const MEMBER_SPEND_MICRO_USD = 1_300_000 + 1_000_000 + 500_000 + 280_000 + 1_000_000;
export const MEMBER_REQUESTS = 5;
export const MEMBER_TOKENS = (400_000 + 50_000) + (300_000 + 40_000) + (150_000 + 20_000) + (90_000 + 10_000) + (100_000 + 20_000);
/** The member's monthly limit and what they have used of it this month. */
export const MEMBER_LIMIT_MICRO_USD = 20_000_000;
export const MEMBER_LIMIT_USED_MICRO_USD = 4_080_000;
/** The peer's usage, which must never show on the member's page. */
export const PEER_SPEND_MICRO_USD = 987_650_000;

/**
 * My Usage: a real Den with AI Gateway on, an Anthropic provider shared with
 * everyone, a $20 monthly limit for one member, and completed Gateway requests
 * for that member and for a peer on the same days. The member is signed in on
 * Den Web.
 */
export async function memberUsagePageWorld(seed: Seed) {
  const den = await seed.den({
    env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:1", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:1" },
    org: { name: "Usage workspace", admin: { name: "Usage Admin" }, members: { member: { name: "Robin Member" }, peer: { name: "Sam Peer" } } },
  });
  const database = den.database?.url;
  if (!database || !new URL(database).pathname.startsWith("/openwork_eval_")) throw new Error("My Usage fixtures require an isolated testkit database.");
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("Expected the seeded organization.");

  const created = await seed.api(den.admin, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({ name: "Team Anthropic", providerId: "anthropic", modelIds: [...MEMBER_USAGE_MODELS], credential: { kind: "api_key", secret: "fixture-anthropic-key" }, allMembers: true }),
  });
  const provider = isRecord(created.body) && isRecord(created.body.inferenceProvider) ? created.body.inferenceProvider : null;
  if (created.response.status !== 201 || typeof provider?.id !== "string") throw new Error(`Provider setup failed: HTTP ${created.response.status}`);
  const providerId = provider.id;

  async function memberId(email: string): Promise<string> {
    const rows = await queryDenDatabase(database ?? "", "SELECT id FROM member WHERE organization_id = ? AND user_id = (SELECT id FROM user WHERE email = ?) AND removed_at IS NULL", [organizationId, email]);
    const row = rows[0];
    if (!isRecord(row) || typeof row.id !== "string") throw new Error("Expected a membership.");
    return row.id;
  }
  const member = await memberId(den.members.member.email);
  const peer = await memberId(den.members.peer.email);

  // A $20 monthly limit for the member that pauses their models and lets them ask for more.
  const saved = await seed.api(den.admin, "/v1/gateway/usage-limit-policies", {
    method: "POST", body: JSON.stringify({ name: "Monthly budget", providerId: null, hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costUsd: "20" }] }),
  });
  if (!saved.response.ok) throw new Error(`Limit setup failed: HTTP ${saved.response.status}`);
  const policy = gatewayUsageLimitPolicySchema.parse(saved.body);
  const assigned = await seed.api(den.admin, `/v1/gateway/usage-limit-policies/${policy.id}/assignments`, { method: "POST", body: JSON.stringify({ memberId: member }) });
  if (!assigned.response.ok) throw new Error(`Limit assignment failed: HTTP ${assigned.response.status}`);
  // ARRANGE ONLY: the monthly counter as Gateway admissions leave it after the requests below.
  const read = await seed.api(den.members.member, "/v1/gateway/usage-limits/me");
  if (!read.response.ok) throw new Error(`Limit status failed: HTTP ${read.response.status}`);
  const bucket = gatewayUsageStatusSchema.parse(read.body).buckets.find((entry) => entry.timeframe === "month");
  if (!bucket) throw new Error("Expected the member's monthly limit.");
  const period = gatewayUsagePeriod("month", new Date());
  // Den reads timestamps as UTC; send them as UTC text rather than this machine's local time.
  const utc = (date: Date) => date.toISOString().slice(0, 23).replace("T", " ");
  await queryDenDatabase(database,
    `INSERT INTO gateway_usage_bucket (id, organization_id, member_id, provider_scope, timeframe, start_at, reset_at, policy_id, policy_name, policy_revision, base_allowance_micro_usd, extension_micro_usd, used_micro_usd, unpriced_requests, incomplete_requests, history_unknown, extension_used, hard_limit, allow_request_reset)
     VALUES (?, ?, ?, '', 'month', ?, ?, ?, ?, ?, ?, 0, ?, 0, 0, false, false, true, true)`,
    [bucket.id, organizationId, member, utc(period.start), utc(period.end), bucket.policyId, bucket.policyName, bucket.policyRevision ?? policy.revision, bucket.baseAllowanceMicroUsd, MEMBER_LIMIT_USED_MICRO_USD]);

  // ARRANGE ONLY: completed Gateway requests, as the Gateway records them. Never prompt or completion content.
  let request = 0;
  async function logRequest(membership: string, model: string, input: number, output: number, cost: number, daysAgo: number) {
    request += 1;
    const id = `irl_${String(request).padStart(26, "0")}`;
    await queryDenDatabase(database ?? "",
      `INSERT INTO gateway_request_logs (id, organization_id, org_membership_id, gateway_provider_id, route, protocol, upstream_provider_id, upstream_host, upstream_path, method, upstream_model, stream, status, outcome, input_tokens, output_tokens, total_tokens, usage_source, cost_micro_usd, openwork_request_id, started_at, completed_at)
       VALUES (?, ?, ?, ?, 'org_provider', 'anthropic_messages', 'anthropic', 'api.anthropic.com', '/v1/messages', 'POST', ?, 1, 200, 'ok', ?, ?, ?, 'stream', ?, ?, DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY), DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY))`,
      [id, organizationId, membership, providerId, model, input, output, input + output, cost, `member-usage-${request}`, daysAgo, daysAgo]);
  }
  await logRequest(member, "claude-sonnet-5", 400_000, 50_000, 1_300_000, 1);
  await logRequest(member, "claude-sonnet-5", 300_000, 40_000, 1_000_000, 3);
  await logRequest(member, "claude-sonnet-5", 150_000, 20_000, 500_000, 6);
  await logRequest(member, "claude-sonnet-5", 90_000, 10_000, 280_000, 9);
  await logRequest(member, "claude-opus-5", 100_000, 20_000, 1_000_000, 2);
  await logRequest(peer, "claude-opus-5", 9_000_000, 900_000, PEER_SPEND_MICRO_USD, 2);

  const web = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard", headless: true, viewport: { width: 1440, height: 2000 } });
  return {
    den,
    web,
    organizationId,
    memberId: member,
    /** The member's own usage as Den returns it, to compare with what the page shows. */
    async ownUsage() {
      const result = await seed.api(den.members.member, "/v1/gateway/usage/me");
      return { status: result.response.status, body: result.response.ok ? gatewayMemberUsageResponseSchema.parse(result.body) : null };
    },
    async ownLimits() {
      const result = await seed.api(den.members.member, "/v1/gateway/usage-limits/me");
      return gatewayUsageStatusSchema.parse(result.body);
    },
  };
}
