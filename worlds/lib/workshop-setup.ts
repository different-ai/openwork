import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import type { DenSession } from "../../evals/packages/behaviors/src/den.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";

export const WORKSHOP_MODEL = "gpt-6.1-sol";
export const WORKSHOP_ATTENDEES = 20;
/** Upper bound for one Den: seat names stay two digits (attendee01..attendee99). */
export const WORKSHOP_MAX_ATTENDEES = 99;
export const WORKSHOP_BUDGET_CAVEAT = "Estimated cost, not a prepaid balance or an upstream billing cap. Admission checks settled spend; in-flight requests can overshoot. Weekly allowances reset Monday at 05:00 UTC; stop the workshop before that reset so each seat keeps one allowance for the event.";

export const WORKSHOP_CONNECTIONS = [
  { key: "outlook", name: "Workshop Outlook" },
  { key: "calendar", name: "Workshop Calendar" },
  { key: "drive", name: "Workshop Drive" },
  { key: "jira", name: "Workshop Jira" },
  { key: "confluence", name: "Workshop Confluence" },
].map((entry) => ({ ...entry, url: `https://open-workplace-workshop.onrender.com/${entry.key}/mcp` }));

export interface WorkshopSetupOptions {
  /** Controller-only secret: fetch in the caller, never put in a world manifest or sandbox environment. */
  upstreamKey: string;
  provider?: "openai";
  modelId?: string;
  /** Positive USD amount, at most the approved $5 per attendee, with at most six decimal places. */
  allowanceUsd: number;
  /** Ordinary attendee sessions expected in the organization: 1..20 (default 20). */
  attendees?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!record(value) || !record(value[field])) throw new Error(`Workshop response missing ${field}.`);
  return value[field];
}

function id(value: Record<string, unknown>): string {
  if (typeof value.id !== "string" || !value.id) throw new Error("Workshop response missing resource ID.");
  return value.id;
}

/** Only status codes escape this boundary: neither upstream credentials nor Den response bodies belong in logs. */
async function request(session: DenSession, path: string, orgId?: string, body?: unknown, method = "POST"): Promise<unknown> {
  const headers: Record<string, string> = { authorization: `Bearer ${session.token}` };
  if (orgId) headers["x-openwork-org-id"] = orgId;
  const result = await denFetch(session, path, {
    headers, method: body === undefined ? "GET" : method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => { throw new Error("Workshop Den request failed (transport error; details withheld)."); });
  if (!result.response.ok) throw new Error(`Workshop Den request failed at ${path}: HTTP ${result.response.status}.`);
  return result.body;
}

/**
 * Configure an ALREADY booted, private, shared Den + Gateway. The recipe must
 * create exactly 20 ordinary accounts via server({ org: { members } }) and/or
 * inviteMember first. No infrastructure, signup, secret lookup, OAuth browser
 * flow, or paid inference request is performed here. Keep den.admin and the
 * DenSession objects in the controller's private context, not attendee output.
 *
 * OAuth uses real server discovery with per-person sign-in. No made-up autoJoin
 * metadata is sent to Den: Guest/automatic join is supplied by the workplace
 * authorization server and completed in each attendee's own browser profile.
 * Repeated calls upsert the five keyed connections rather than duplicate them.
 */
export async function configureWorkshop(den: Den, options: WorkshopSetupOptions) {
  if (!options.upstreamKey.trim()) throw new Error("Workshop requires a controller-provided upstream key.");
  const costUsd = String(options.allowanceUsd);
  if (!Number.isFinite(options.allowanceUsd) || options.allowanceUsd <= 0 || options.allowanceUsd > 5
    || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(costUsd)) {
    throw new Error("Workshop allowance must be positive, at most $5, and have at most six decimal places.");
  }
  if (!den.gateway?.publicUrl) throw new Error("Boot the shared Den with its real co-located Gateway before configuring the workshop.");
  const expected = options.attendees ?? WORKSHOP_ATTENDEES;
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > WORKSHOP_MAX_ATTENDEES) throw new Error(`Workshop attendee count must be 1..${WORKSHOP_MAX_ATTENDEES}.`);
  const sessions = Object.entries(den.members);
  if (sessions.length !== expected) throw new Error(`Workshop requires exactly ${expected} approved ordinary member sessions.`);
  const emails = sessions.map(([, session]) => session.email.trim().toLowerCase());
  if (new Set(emails).size !== expected || emails.includes("") || emails.includes(den.admin.email.trim().toLowerCase())
    || sessions.some(([, session]) => !session.token || session.token === den.admin.token
      || session.apiUrl !== den.ref.apiUrl || session.webUrl !== den.ref.webUrl)) {
    throw new Error("Workshop attendees must be unique ordinary members of the shared Den, never the owner/admin session.");
  }
  const context = await request(den.admin, "/v1/org");
  const orgId = id(object(context, "organization"));
  const adminMemberId = id(object(context, "currentMember"));
  if (!record(context) || !record(context.deploymentCapabilities) || context.deploymentCapabilities.aiGateway !== true) {
    throw new Error("Shared Den does not advertise an enabled AI Gateway deployment.");
  }
  // Resolve membership IDs as EACH member, not user IDs or directory search guesses.
  // Finish the full role check before creating a provider or assigning any allowance.
  const attendees: { key: string; memberId: string; session: DenSession }[] = [];
  for (const [key, session] of sessions) {
    const memberContext = await request(session, "/v1/org", orgId);
    const member = object(memberContext, "currentMember");
    const memberId = id(member);
    if (id(object(memberContext, "organization")) !== orgId || member.role !== "member"
      || (member.directRole !== undefined && member.directRole !== "member") || member.isOwner !== false
      || memberId === adminMemberId || attendees.some((attendee) => attendee.memberId === memberId)
      || (record(memberContext) && memberContext.canManageDeploymentServices === true)
      || (Array.isArray(member.permissions) && member.permissions.some((permission) =>
        permission === "gateway_providers.manage" || permission === "gateway_limits.manage"))) {
      throw new Error("Workshop attendee is not a unique ordinary member (owners/admins are forbidden).");
    }
    attendees.push({ key, memberId, session });
  }

  // The provider is granted to these member IDs only. Still refuse a pre-seeded/demo
  // directory with extra people: those unapproved accounts would be unbudgeted.
  const approvedIds = new Set([adminMemberId, ...attendees.map((attendee) => attendee.memberId)]);
  const directory = record(context) && Array.isArray(context.members) ? context.members.filter(record) : [];
  if (directory.length !== approvedIds.size || directory.some((member) => !approvedIds.has(id(member)))) {
    throw new Error("Workshop organization must contain only the controller and the 20 approved attendees.");
  }

  // Install direct, per-member limits BEFORE granting the shared real provider.
  // Never use { organization: true }: that would also budget the owner/admin.
  const policy = await request(den.admin, "/v1/gateway/usage-limit-policies", orgId, {
    name: "Workshop weekly allowance", hardLimit: true, allowRequestReset: false,
    limits: [{ timeframe: "week", costUsd }],
  });
  if (!record(policy)) throw new Error("Workshop policy response invalid.");
  const policyId = id(policy);
  for (const attendee of attendees) {
    await request(den.admin, `/v1/gateway/usage-limit-policies/${encodeURIComponent(policyId)}/assignments`, orgId, { memberId: attendee.memberId });
  }
  const allowanceMicroUsd = Math.round(options.allowanceUsd * 1_000_000);
  for (const attendee of attendees) {
    const status = await request(attendee.session, "/v1/gateway/usage-limits/me", orgId);
    const buckets = record(status) && Array.isArray(status.buckets) ? status.buckets.filter(record) : [];
    const bucket = buckets[0];
    // Higher winning policies, provider overrides and old extensions must not silently expand the approved budget.
    if (!record(status) || status.memberId !== attendee.memberId || status.organizationId !== orgId
      || buckets.length !== 1 || !bucket || bucket.policyId !== policyId || bucket.timeframe !== "week"
      || bucket.baseAllowanceMicroUsd !== allowanceMicroUsd || bucket.allowanceMicroUsd !== allowanceMicroUsd
      || bucket.extensionMicroUsd !== 0 || bucket.hardLimit !== true || bucket.allowRequestReset !== false
      || (Array.isArray(status.providers) && status.providers.length > 0)) {
      throw new Error("Workshop member's effective allowance does not match the approved hard weekly budget.");
    }
  }

  const upstreamModelId = options.modelId ?? WORKSHOP_MODEL;
  const created = await request(den.admin, "/v1/inference-providers", orgId, {
    name: "Workshop Sol 6.1", providerId: options.provider ?? "openai", modelIds: [upstreamModelId],
    credential: { kind: "api_key", secret: options.upstreamKey },
    // Grant only the validated, budgeted attendees: a member added later gets no
    // provider access, so nobody can use the shared key outside an allowance.
    settings: { upstreamBaseUrl: "https://api.openai.com/v1" }, memberIds: attendees.map((attendee) => attendee.memberId),
  });
  const providerId = id(object(created, "inferenceProvider"));
  const models: { key: string; memberId: string; modelId: string; allowanceUsd: number }[] = [];
  for (const attendee of attendees) {
    const listed = await request(attendee.session, "/v1/inference-providers?scope=usable", orgId);
    const providers = record(listed) && Array.isArray(listed.inferenceProviders) ? listed.inferenceProviders.filter(record) : [];
    if (!providers.some((provider) => provider.id === providerId && provider.source === "openwork_gateway")) {
      throw new Error("Workshop managed provider is not visible to an ordinary member.");
    }
    const connected = object(await request(attendee.session, `/v1/inference-providers/${encodeURIComponent(providerId)}/connect`, orgId), "inferenceProvider");
    const available = Array.isArray(connected.models) ? connected.models.filter(record) : [];
    const model = available.find((entry) => entry.upstreamModelId === upstreamModelId);
    if (connected.source !== "openwork_gateway" || connected.credentialStatus !== "ready"
      || typeof connected.apiKey !== "string" || !connected.apiKey || connected.apiKey === options.upstreamKey
      || !model || available.length !== 1 || JSON.stringify(connected).includes(options.upstreamKey)) {
      throw new Error("Workshop member Gateway connect payload is not usable or exposes the upstream credential.");
    }
    models.push({ key: attendee.key, memberId: attendee.memberId, modelId: id(model), allowanceUsd: options.allowanceUsd });
    // The caller's issued Gateway apiKey remains here; it is never returned or written to disk.
  }

  const connections: { key: string; id: string; url: string }[] = [];
  for (const connection of WORKSHOP_CONNECTIONS) {
    const createdConnection = await request(den.admin, `/v1/mcp-connections/by-key/workshop-${connection.key}`, orgId, {
      kind: "external_mcp", name: connection.name, url: connection.url,
      authType: "oauth", credentialMode: "per_member", exposeDirectly: true, access: { orgWide: true },
    }, "PUT");
    if (!record(createdConnection)) throw new Error("Workshop connection response invalid.");
    connections.push({ key: connection.key, id: id(createdConnection), url: connection.url });
  }
  // Explicit allowlist only: do not spread server responses or serialize den/admin/member sessions.
  const modelId = models[0]?.modelId;
  if (!modelId || models.some((model) => model.modelId !== modelId)) throw new Error("Workshop members did not receive the same shared model alias.");
  const summary = {
    orgId, providerId, modelId, upstreamModelId, policyId, members: models, connections,
    allowanceUsd: options.allowanceUsd, totalEstimatedAllowanceUsd: options.allowanceUsd * attendees.length,
    budgetCaveat: WORKSHOP_BUDGET_CAVEAT, inferenceRequestVerified: false,
  };
  if (JSON.stringify(summary).includes(options.upstreamKey)) throw new Error("Workshop public summary failed credential isolation.");
  return summary;
}
