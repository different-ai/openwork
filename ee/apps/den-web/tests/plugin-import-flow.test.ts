import { describe, expect, test } from "bun:test";

import { getImportPluginRoute } from "../app/(den)/_lib/den-org";
import {
  clearPluginImportDraft,
  loadPluginImportDraft,
  minimizePluginImportDraft,
  normalizePublicGitHubPluginUrl,
  parsePluginImportPreview,
  pluginImportSourceLabel,
  pluginImportSuggestedName,
  savePluginImportDraft,
  type PluginImportDraft,
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

  test("accepts only public credential-free GitHub URLs", () => {
    expect(normalizePublicGitHubPluginUrl(" https://github.com/acme/plugin/tree/main/sales "))
      .toBe("https://github.com/acme/plugin/tree/main/sales");

    for (const unsafeUrl of [
      "http://github.com/acme/plugin",
      "https://token@github.com/acme/plugin",
      "https://github.com/acme/plugin?token=secret",
      "https://example.com/acme/plugin",
      "javascript:alert(1)",
    ]) {
      expect(() => normalizePublicGitHubPluginUrl(unsafeUrl)).toThrow();
    }
  });

  test("persists and migrates selected non-sensitive import metadata across fresh reloads", () => {
    const sourceDraft: PluginImportDraft = {
      version: 1,
      authType: "none",
      credentialMode: "shared",
      githubUrl: "https://github.com/acme/plugin/tree/main/sales",
      preview: {
        repositoryFullName: "acme/plugin",
        rootPath: "sales",
        servers: [
          { name: "CRM", serverKey: "crm", url: "https://mcp.example.com/mcp?region=us", supported: true, skippedReason: null },
          { name: "Skipped", serverKey: "skipped", url: "https://unused.example.com/mcp", supported: true, skippedReason: null },
        ],
        skills: [
          { name: "Research", skillKey: "research", sourcePath: "skills/research/SKILL.md", description: "Private preview copy", supported: true, skippedReason: null },
        ],
        warnings: ["Preview-only warning"],
      },
      selectedServerKeys: ["crm"],
      selectedSkillKeys: ["research"],
    };
    const draft = minimizePluginImportDraft(sourceDraft);

    expect(draft.preview.servers).toEqual([
      { name: "CRM", serverKey: "crm", url: null, supported: true, skippedReason: null },
    ]);
    expect(draft.preview.skills[0]?.description).toBeNull();
    expect(draft.preview.warnings).toEqual([]);
    expect(JSON.stringify(draft)).not.toContain("mcp.example.com");
    expect(JSON.stringify(draft)).not.toContain("Private preview copy");
    expect(JSON.stringify(draft)).not.toContain("unused.example.com");

    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const storedValues = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        sessionStorage: {
          getItem: (key: string) => storedValues.get(key) ?? null,
          setItem: (key: string, value: string) => storedValues.set(key, value),
          removeItem: (key: string) => storedValues.delete(key),
        },
      },
    });
    try {
      savePluginImportDraft(sourceDraft);
      const persisted = [...storedValues.values()][0] ?? "";
      expect(persisted).toContain('"serverMode":"none"');
      expect(persisted).toContain('"accountScope":"shared"');
      expect(persisted).not.toContain('"authType"');
      expect(persisted).not.toContain('"credentialMode"');
      expect(persisted).not.toContain("mcp.example.com");
      expect(loadPluginImportDraft()).toMatchObject({
        authType: "none",
        credentialMode: "shared",
      });

      storedValues.set("openwork.plugin-import-draft.v1", JSON.stringify({
        ...draft,
        authType: "none",
        credentialMode: "shared",
      }));
      expect(loadPluginImportDraft()).toMatchObject({
        authType: "none",
        credentialMode: "shared",
      });

      storedValues.set("openwork.plugin-import-draft.v1", JSON.stringify({
        version: draft.version,
        githubUrl: draft.githubUrl,
        preview: draft.preview,
        selectedServerKeys: draft.selectedServerKeys,
        selectedSkillKeys: draft.selectedSkillKeys,
      }));
      expect(loadPluginImportDraft()).toMatchObject({
        authType: "oauth",
        credentialMode: "per_member",
        githubUrl: draft.githubUrl,
        selectedServerKeys: ["crm"],
        selectedSkillKeys: ["research"],
      });
      expect(storedValues.has("openwork.plugin-import-draft.v1")).toBe(true);
      clearPluginImportDraft();
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("rejects selected server URLs that are unsafe or credential-bearing", () => {
    const draftForServerUrl = (url: string): PluginImportDraft => ({
      version: 1,
      authType: "oauth",
      credentialMode: "per_member",
      githubUrl: "https://github.com/acme/plugin",
      preview: {
        repositoryFullName: "acme/plugin",
        rootPath: "",
        servers: [{ name: "CRM", serverKey: "crm", url, supported: true, skippedReason: null }],
        skills: [],
        warnings: [],
      },
      selectedServerKeys: ["crm"],
      selectedSkillKeys: [],
    });

    for (const unsafeUrl of [
      "http://mcp.example.com/mcp",
      "https://user:secret@mcp.example.com/mcp",
      "https://mcp.example.com/mcp?api_key=secret",
      "javascript:alert(1)",
    ]) {
      expect(() => minimizePluginImportDraft(draftForServerUrl(unsafeUrl))).toThrow();
    }
  });

  test("preserves Agent Plugin compatibility warnings in the draft", () => {
    const preview = parsePluginImportPreview({
      item: {
        repositoryFullName: "different-ai/team-tools",
        rootPath: "plugins/portable",
        servers: [{
          name: "local-tool",
          serverKey: "local-tool",
          url: null,
          supported: false,
          skippedReason: "local_unsupported",
        }, {
          name: "header-tool",
          serverKey: "header-tool",
          url: "https://mcp.example.test/mcp",
          supported: false,
          skippedReason: "headers_unsupported",
        }],
        skills: [],
        warnings: ["Skill assets are not installed yet."],
      },
    });

    expect(preview.servers.map((server) => server.skippedReason)).toEqual([
      "local_unsupported",
      "headers_unsupported",
    ]);
    expect(preview.warnings).toEqual(["Skill assets are not installed yet."]);
  });
});
