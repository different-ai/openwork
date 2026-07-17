import { describe, expect, test } from "bun:test";

process.env.DEN_DB_ENCRYPTION_KEY = "test-den-db-encryption-key-please-change-1234567890";
process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-please-change-1234567890";
process.env.BETTER_AUTH_URL = "http://localhost:3005";
process.env.CORS_ORIGINS = "http://localhost:3005";
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_test";

const { githubPluginMcpImportSchema } = await import("../src/routes/org/plugin-system/schemas");

describe("GitHub plugin import creation contract", () => {
  test("accepts create-screen metadata without requiring publication or org-wide access", () => {
    const result = githubPluginMcpImportSchema.safeParse({
      access: { orgWide: false, memberIds: ["om_01h00000000000000000000000"], teamIds: [] },
      authType: "oauth",
      credentialMode: "per_member",
      description: "A private imported plugin draft.",
      githubUrl: "https://github.com/anthropics/knowledge-work-plugins/tree/main/sales",
      name: "Sales toolkit",
      selectedServerKeys: ["salesforce"],
      selectedSkillKeys: ["account-research"],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.marketplaceId).toBeUndefined();
    expect(result.data.name).toBe("Sales toolkit");
    expect(result.data.access.orgWide).toBe(false);
  });
});
