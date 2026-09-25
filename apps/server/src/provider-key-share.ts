import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./errors.js";
import type { CloudProviderDenSession } from "./cloud-provider-sync.js";
import type { EnvRecord } from "./env-file.js";
import { externalFetch } from "./server-fetch.js";

export const providerKeyShareInput = z.object({
  organizationId: z.string().min(1), memberId: z.string().min(1), providerId: z.string().min(1),
  allMembers: z.boolean(), teamIds: z.array(z.string().min(1)).max(100), removeLocal: z.boolean(), confirmed: z.literal(true),
}).strict().refine((input) => input.allMembers ? input.teamIds.length === 0 : input.teamIds.length > 0, "Choose everyone or selected teams.");

const eligibilitySchema = z.object({
  organizationId: z.string().min(1), memberId: z.string().min(1), organizationName: z.string().min(1),
  teams: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })), eligible: z.boolean(), reason: z.string().nullable(),
});
const receiptSchema = z.object({ requestId: z.string().uuid(), organizationId: z.string(), providerId: z.string(), inferenceProviderId: z.string().min(1) });
const journalSchema = z.object({ requestId: z.string().uuid(), audience: z.string(), sourceVersion: z.number(), localRemoved: z.boolean().optional(), receipt: receiptSchema.optional() });
export type ProviderKeyShareEligibility = z.infer<typeof eligibilitySchema>;
export type ProviderKeyShareReceipt = z.infer<typeof receiptSchema>;
type Journal = z.infer<typeof journalSchema>;
export type ProviderKeyShareDependencies = {
  source: { describe: (providerId: string) => Promise<{ name: string }>; read: (providerId: string) => Promise<EnvRecord>; remove: (providerId: string, expected: EnvRecord, isCurrent: () => void) => Promise<boolean> };
  readJournal: (key: string) => Promise<unknown>;
  writeJournal: (key: string, value: Journal, isCurrent: () => void) => Promise<void>;
  /** Den transport; defaults to the audited external egress client. */
  transport?: (input: string, init?: RequestInit) => Promise<Response>;
  allowLocalDen?: boolean;
};

export class ProviderKeyShareService {
  private session: CloudProviderDenSession | null = null;
  private controller = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly dependencies: ProviderKeyShareDependencies) {}

  setSession(session: CloudProviderDenSession | null) {
    if (this.session?.baseUrl === session?.baseUrl && this.session?.token === session?.token && this.session?.orgId === session?.orgId) return;
    this.controller.abort();
    this.controller = new AbortController();
    this.session = session ? { ...session } : null;
  }

  private context(organizationId: string) {
    const session = this.session;
    const controller = this.controller;
    if (!session || session.orgId !== organizationId) throw new ApiError(409, "share_identity_changed", "Sign in and select the organization again before sharing.");
    const url = new URL(session.baseUrl);
    const local = this.dependencies.allowLocalDen && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new ApiError(403, "share_origin_unavailable", "This Den connection cannot receive device credentials.");
    const isCurrent = () => {
      if (this.session !== session || controller.signal.aborted) throw new ApiError(409, "share_identity_changed", "The account changed. No local key was removed.");
    };
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      isCurrent();
      try {
        const response = await (this.dependencies.transport ?? externalFetch)(`${url.href.replace(/\/+$/, "")}${path}`, {
          method: body === undefined ? "GET" : "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${session.token}`, "x-openwork-org-id": session.orgId, "x-openwork-legacy-org-id": session.orgId },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        isCurrent();
        if (!response.ok) {
          await response.body?.cancel();
          throw new ApiError(response.status === 401 || response.status === 403 ? 403 : 503, "share_unverified", response.status === 401 || response.status === 403 ? "A freshly verified organization administrator must authorize sharing in Den. Your local key is unchanged." : "Den could not confirm sharing. Your local key is unchanged; retry uses the same transfer.");
        }
        const value: unknown = await response.json();
        isCurrent();
        return value;
      } catch (error) {
        isCurrent();
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, "share_unverified", "Den could not confirm sharing. Your local key is unchanged; retry uses the same transfer.");
      }
    };
    return { session, baseUrl: url.href.replace(/\/+$/, ""), isCurrent, request };
  }

  private async verify(providerId: string, organizationId: string): Promise<ProviderKeyShareEligibility> {
    const context = this.context(organizationId);
    const result = eligibilitySchema.safeParse(await context.request(`/v1/inference-providers/share-local-key/eligibility?providerId=${encodeURIComponent(providerId)}`));
    if (!result.success || result.data.organizationId !== organizationId) throw new ApiError(503, "share_contract_unavailable", "This Den server cannot verify secure device-key sharing. Update Den before sharing.");
    context.isCurrent();
    return result.data;
  }

  async eligibility(providerId: string, organizationId: string): Promise<ProviderKeyShareEligibility> {
    const context = this.context(organizationId);
    const eligibility = await this.verify(providerId, organizationId);
    context.isCurrent();
    if (eligibility.eligible) await this.dependencies.source.describe(providerId);
    context.isCurrent();
    return eligibility;
  }

  share(raw: unknown) {
    const parsed = providerKeyShareInput.safeParse(raw);
    if (!parsed.success) return Promise.reject(new ApiError(400, "invalid_share", "Confirm the organization and choose everyone or selected teams."));
    const input = parsed.data;
    const context = this.context(input.organizationId);
    const run = this.queue.then(async () => {
      context.isCurrent();
      const eligibility = await this.verify(input.providerId, input.organizationId);
      context.isCurrent();
      if (!eligibility.eligible || eligibility.memberId !== input.memberId) throw new ApiError(403, "share_not_allowed", "Sharing requires a freshly verified administrator in this organization.");
      if (input.teamIds.some((id) => !eligibility.teams.some((team) => team.id === id))) throw new ApiError(400, "share_audience_changed", "The selected teams are no longer available. Choose the audience again.");
      const key = createHash("sha256").update(JSON.stringify([context.baseUrl, input.organizationId, input.memberId, input.providerId])).digest("hex");
      const audience = JSON.stringify([input.allMembers, [...new Set(input.teamIds)].sort()]);
      const saved = await this.dependencies.readJournal(key);
      context.isCurrent();
      const previous = saved === null || saved === undefined ? null : journalSchema.safeParse(saved);
      if (previous && !previous.success) throw new ApiError(409, "share_receipt_invalid", "An earlier transfer needs verification in Den. Your local key is unchanged.");
      if (previous?.success && previous.data.audience !== audience) throw new ApiError(409, "share_audience_changed", "This key already has a transfer for another audience. Change access in Den.");
      if (previous?.success && previous.data.receipt && previous.data.localRemoved) return { share: previous.data.receipt, localRemoved: true };
      let secret: EnvRecord;
      try { secret = await this.dependencies.source.read(input.providerId); }
      catch (error) {
        context.isCurrent();
        if (previous?.success && previous.data.receipt) return { share: previous.data.receipt, localRemoved: false };
        throw error;
      }
      context.isCurrent();
      const journal: Journal = previous?.success ? previous.data : { requestId: randomUUID(), audience, sourceVersion: secret.updatedAt };
      if (journal.sourceVersion !== secret.updatedAt) throw new ApiError(409, "share_key_changed", "The device key changed after an earlier transfer. Verify that transfer in Den; no new transfer or local removal was attempted.");
      const metadata = await this.dependencies.source.describe(input.providerId);
      context.isCurrent();
      if (journal.audience !== audience) throw new ApiError(409, "share_audience_changed", "This key already has a transfer for another audience. Verify it and change access in Den.");
      if (!previous) await this.dependencies.writeJournal(key, journal, context.isCurrent);
      context.isCurrent();
      if (!journal.receipt) {
        const response = await context.request("/v1/inference-providers/share-local-key", { requestId: journal.requestId, providerId: input.providerId, name: metadata.name, credential: { kind: "api_key", secret: secret.value }, allMembers: input.allMembers, teamIds: [...new Set(input.teamIds)].sort() });
        const result = z.object({ share: receiptSchema }).safeParse(response);
        context.isCurrent();
        if (!result.success || result.data.share.requestId !== journal.requestId || result.data.share.organizationId !== input.organizationId || result.data.share.providerId !== input.providerId) throw new ApiError(503, "share_unverified", "The transfer receipt could not be verified. Your local key is unchanged.");
        journal.receipt = result.data.share;
        await this.dependencies.writeJournal(key, journal, context.isCurrent);
      }
      context.isCurrent();
      let localRemoved = false;
      if (input.removeLocal) {
        try { localRemoved = await this.dependencies.source.remove(input.providerId, secret, context.isCurrent); }
        catch { context.isCurrent(); }
      }
      journal.localRemoved = localRemoved;
      await this.dependencies.writeJournal(key, journal, context.isCurrent);
      context.isCurrent();
      return { share: journal.receipt, localRemoved };
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
