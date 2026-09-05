import { denFetch } from "@openwork/behaviors";
import type { DenRef } from "@openwork/behaviors";
import { isRecord, recordField, requiredEnv, stringField } from "./live-den-api.ts";

export function assertLiveCleanupCandidate(user: Record<string, unknown>, startedAt: string): string {
  const id = stringField(user, "id");
  const createdAt = Date.parse(stringField(user, "createdAt") ?? "");
  const started = Date.parse(startedAt);
  if (!id || !Number.isFinite(createdAt) || !Number.isFinite(started) || createdAt < started - 60_000
    || !Array.isArray(user.organizations) || user.organizations.length !== 0 || user.workerCount !== 0) {
    throw new Error("Refusing account cleanup: identity is not fresh or still owns memberships/workers");
  }
  return id;
}

/** Admin credentials never enter the browser or evidence. Only exact owned emails are searched. */
export async function deleteLiveAccount(den: DenRef, email: string, startedAt: string): Promise<void> {
  if (!/^openwork-live-\d+(?:-[a-z0-9]+)*(?:\+[a-z0-9-]+)?@[^@\s]+$/i.test(email)) {
    throw new Error("Refusing account cleanup outside the live-test email namespace");
  }
  const headers = { authorization: `Bearer ${requiredEnv("OPENWORK_EVAL_LIVE_ADMIN_TOKEN")}` };
  async function lookup() {
    const result = await denFetch(den, `/v1/admin/users?search=${encodeURIComponent(email)}&limit=2&includeBilling=false`, { headers });
    if (!result.response.ok || !isRecord(result.body) || !Array.isArray(result.body.users)
      || recordField(result.body, "page")?.hasMore !== false) throw new Error(`Account cleanup lookup failed: HTTP ${result.response.status}`);
    if (!result.body.users.every(isRecord)) throw new Error("Malformed admin user list");
    if (result.body.users.some((user) => user.email !== email)) throw new Error("Account cleanup search returned another identity");
    if (result.body.users.length > 1) throw new Error("Ambiguous account cleanup identity");
    return result.body.users[0];
  }
  const user = await lookup();
  if (!user) return;
  const id = assertLiveCleanupCandidate(user, startedAt);
  const deleted = await denFetch(den, `/v1/admin/users/${encodeURIComponent(id)}`, { method: "DELETE", headers });
  if (!deleted.response.ok) throw new Error(`Owned account deletion failed: HTTP ${deleted.response.status}`);
  if (await lookup()) throw new Error("Owned account remains after deletion");
}

export async function checkLiveCleanupAccess(den: DenRef): Promise<void> {
  const result = await denFetch(den, "/v1/admin/users?search=openwork-live-cleanup-preflight&limit=1&includeBilling=false", {
    headers: { authorization: `Bearer ${requiredEnv("OPENWORK_EVAL_LIVE_ADMIN_TOKEN")}` },
  });
  if (!result.response.ok) throw new Error(`Live cleanup requires a working admin credential before signup: HTTP ${result.response.status}`);
}
