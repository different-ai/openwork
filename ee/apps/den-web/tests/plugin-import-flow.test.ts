import { describe, expect, test } from "bun:test";

import { getImportPluginRoute } from "../app/(den)/_lib/den-org";
import {
  parsePluginImportPreview,
  pluginImportSourceLabel,
  pluginImportSuggestedName,
} from "../app/(den)/dashboard/_components/plugin-import-draft";

describe("plugin import flow", () => {
  test("uses a dedicated import route", () => {
    expect(getImportPluginRoute()).toBe("/dashboard/plugins/import");
    expect(getImportPluginRoute("acme")).toBe("/dashboard/plugins/import");
  });

  test("parses the preview into a creation draft summary", () => {
    const preview = parsePluginImportPreview({
      item: {
        repositoryFullName: "anthropics/knowledge-work-plugins",
        rootPath: "sales",
        servers: [{
          name: "Salesforce",
          serverKey: "salesforce",
          url: "https://mcp.salesforce.example/mcp",
          supported: true,
          skippedReason: null,
        }],
        skills: [{
          name: "Account research",
          skillKey: "account-research",
          sourcePath: "skills/account-research/SKILL.md",
          description: "Research an account before a call.",
          supported: true,
          skippedReason: null,
        }],
        warnings: [],
      },
    });

    expect(pluginImportSourceLabel(preview)).toBe("anthropics/knowledge-work-plugins/sales");
    expect(pluginImportSuggestedName(preview)).toBe("Sales");
    expect(preview.servers[0]?.serverKey).toBe("salesforce");
    expect(preview.skills[0]?.skillKey).toBe("account-research");
  });
});
