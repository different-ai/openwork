import { describe, expect, test } from "bun:test";

import {
  openworkAgentSkillIndexSchema as sharedSkillIndexSchema,
} from "@openwork/types/den/agent-skill-index";

import {
  firstOpenWorkAgentSkillSchemaIssue,
  openworkAgentSkillIndexEntryRuntimeSchema,
  openworkAgentSkillIndexRuntimeSchema as localSkillIndexSchema,
} from "./connect-skill-index-schema.js";

const validIndex = {
  $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  skills: [{
    name: "customer-briefing",
    title: "Customer Briefing",
    type: "skill-md",
    description: "Prepare customer briefings.",
    url: "skill://customer-briefing/SKILL.md",
    capability: "plugin:plg_customer:cfg_briefing",
    marketplaceName: "Customer Success Marketplace",
    pluginName: "Account Planning",
    openworkExtension: true,
  }],
  openwork: {
    totalSkills: 1,
    truncated: false,
  },
  openworkProfile: "authenticated-mcp",
};

describe("OpenWork agent skill-index server-local schema parity", () => {
  test("accepts the same OpenWork MCP profile as the shared contract", () => {
    expect(localSkillIndexSchema.parse(validIndex)).toEqual(
      sharedSkillIndexSchema.parse(validIndex),
    );
  });

  test("keeps new display metadata optional for older skill indexes", () => {
    const legacyIndex = {
      $schema: validIndex.$schema,
      skills: [{
        name: validIndex.skills[0].name,
        type: validIndex.skills[0].type,
        description: validIndex.skills[0].description,
        url: validIndex.skills[0].url,
        capability: validIndex.skills[0].capability,
      }],
    };

    expect(localSkillIndexSchema.parse(legacyIndex)).toEqual(
      sharedSkillIndexSchema.parse(legacyIndex),
    );
  });

  test("rejects the same incompatible envelopes and entries", () => {
    const candidates = [
      { ...validIndex, $schema: "https://unsupported.example/schema.json" },
      { ...validIndex, skills: "not-an-array" },
      {
        ...validIndex,
        skills: [{ ...validIndex.skills[0], name: "Invalid Name" }],
      },
      {
        ...validIndex,
        skills: [{ ...validIndex.skills[0], type: "archive" }],
      },
      {
        ...validIndex,
        skills: [{ ...validIndex.skills[0], url: "https://example.com/SKILL.md" }],
      },
      {
        ...validIndex,
        skills: [{ ...validIndex.skills[0], capability: "plugin:missing-config-object" }],
      },
      {
        ...validIndex,
        skills: [{ ...validIndex.skills[0], title: "x".repeat(256) }],
      },
      {
        ...validIndex,
        skills: [{ ...validIndex.skills[0], marketplaceName: "x".repeat(256) }],
      },
      {
        ...validIndex,
        skills: [{ ...validIndex.skills[0], pluginName: "x".repeat(256) }],
      },
      {
        ...validIndex,
        openwork: { totalSkills: -1, truncated: true },
      },
      {
        ...validIndex,
        openwork: {
          totalSkills: 2,
          truncated: true,
          truncationReason: "unknown-limit",
        },
      },
    ];

    for (const candidate of candidates) {
      expect(localSkillIndexSchema.safeParse(candidate).success).toBe(false);
      expect(sharedSkillIndexSchema.safeParse(candidate).success).toBe(false);
    }
  });

  test("returns only schema-owned issue code and path", () => {
    const privateCanary = "private-schema-value-74ab";
    const parsed = openworkAgentSkillIndexEntryRuntimeSchema.safeParse({
      ...validIndex.skills[0],
      capability: `plugin:${privateCanary}:too:many-segments`,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected an invalid capability");

    const issue = firstOpenWorkAgentSkillSchemaIssue(parsed.error, ["skills", 7]);
    expect(issue).toEqual({
      code: "invalid_format",
      path: "skills.7.capability",
    });
    expect(JSON.stringify(issue)).not.toContain(privateCanary);
  });
});
