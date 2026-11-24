import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

/** Real isolated Den HTTP and database; no browser, mocked routes or feature response fixtures. */
export async function gaFeatureRetirementWorld(seed: Seed) {
  const den = await seed.den({ org: {
    name: "GA feature workspace", admin: { name: "Platform Operator" },
    members: { member: { name: "Workspace Member" } },
  } });
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("Missing retirement proof organization");
  const context = await seed.api(den.members.member, "/v1/org");
  if (!isRecord(context.body) || !isRecord(context.body.currentMember) || typeof context.body.currentMember.id !== "string") throw new Error("Missing retirement proof membership");
  const memberId = context.body.currentMember.id;
  return {
    async list(path: string, field: "features" | "capabilities" | "featureStates") {
      const result = await seed.api(den.admin, path);
      if (!result.response.ok || !isRecord(result.body)) throw new Error(`${path}: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
      const value = result.body[field];
      if (Array.isArray(value)) return records(value).map(row => {
        if (typeof row.key !== "string") throw new Error(`${path}: feature key missing`);
        return row.key;
      });
      if (isRecord(value)) return Object.keys(value);
      throw new Error(`${path}: ${field} missing`);
    },
    async changeGlobal(key: string) {
      return (await seed.api(den.admin, `/v1/admin/features/${key}`, { method: "PUT", body: JSON.stringify({ enabled: false, killed: true }) })).response.status;
    },
    async memberRead() { return (await seed.api(den.members.member, "/v1/admin/features")).response.status; },
    organizationPath: `/v1/admin/organizations/${organizationId}`,
    memberPath: `/v1/admin/organizations/${organizationId}/members/${memberId}/capabilities`,
  };
}
