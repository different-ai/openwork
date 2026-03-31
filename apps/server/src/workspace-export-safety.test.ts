import { describe, expect, test } from "bun:test";

import {
  collectWorkspaceExportWarnings,
  stripSensitiveWorkspaceExportData,
} from "./workspace-export-safety.js";

describe("workspace export safety", () => {
  test("does not warn for benign mcp, plugin, and portable files", () => {
    const warnings = collectWorkspaceExportWarnings({
      opencode: {
        mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", key: "primary" } },
        plugin: { demo: { key: "theme-dark" } },
      },
      files: [
        { path: ".opencode/plugins/demo/index.ts", content: "const key = 'primary'; export default { enabled: true }" },
        { path: ".opencode/tools/run.ts", content: "console.log('hello')" },
      ],
    });

    expect(warnings).toEqual([]);
  });

  test("warns only when secret-like keys or values are present", () => {
    const warnings = collectWorkspaceExportWarnings({
      opencode: {
        mcp: {
          jira: {
            headers: { Authorization: "Bearer abcdefghijklmnop" },
            apiKey: "super-secret-key",
          },
        },
        plugin: {
          demo: { token: "ghp_1234567890abcdef", enabled: true, key: "AbCDef1234567890+/token" },
        },
      },
      files: [
        { path: ".opencode/plugins/demo/index.ts", content: "const apiKey = 'abc123456789';" },
        {
          path: ".opencode/tools/run.ts",
          content: 'const key = "AbCdEf1234567890+/token"; fetch("https://example.com/path/with/a/really/long/url/that/looks/suspicious/123456789")',
        },
      ],
    });

    expect(warnings.map((warning) => warning.id)).toEqual([
      "mcp-config",
      "plugin-config",
      "portable-file:.opencode/plugins/demo/index.ts",
      "portable-file:.opencode/tools/run.ts",
    ]);
    expect(warnings[0]?.detail).toContain("apiKey");
    expect(warnings[0]?.detail).toContain("Bearer");
    expect(warnings[1]?.detail).toContain("token");
    expect(warnings[1]?.detail).toContain("key");
    expect(warnings[2]?.detail).toContain("apiKey");
    expect(warnings[3]?.detail).toContain("key");
    expect(warnings[3]?.detail).toContain("long URL");
  });

  test("warns when a non-portable provider section still contains secrets", () => {
    const warnings = collectWorkspaceExportWarnings({
      opencode: {
        provider: {
          openai: {
            options: {
              apiKey: "sk_live_1234567890abcdef",
            },
          },
        },
        mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp" } },
      },
      files: [],
    });

    expect(warnings.map((warning) => warning.id)).toEqual(["provider-config"]);
    expect(warnings[0]?.label).toBe("Provider settings");
    expect(warnings[0]?.detail).toContain("apiKey");
  });

  test("exclude mode removes only flagged values and files", () => {
    const sanitized = stripSensitiveWorkspaceExportData({
      opencode: {
        plugin: {
          demo: {
            enabled: true,
            token: "ghp_1234567890abcdef",
          },
        },
        mcp: {
          jira: {
            enabled: true,
            apiKey: "super-secret-key",
            url: "https://jira.example.com/mcp",
          },
        },
        command: { review: { template: "Review it" } },
      },
      files: [
        { path: ".opencode/plugins/demo/index.ts", content: "const token = 'secret';" },
        { path: ".opencode/tools/run.ts", content: "console.log('safe tool');" },
        { path: ".opencode/agents/reviewer.md", content: "agent" },
      ],
    });

    expect(sanitized.opencode).toEqual({
      plugin: { demo: { enabled: true } },
      mcp: { jira: { enabled: true, url: "https://jira.example.com/mcp" } },
      command: { review: { template: "Review it" } },
    });
    expect(sanitized.files).toEqual([
      { path: ".opencode/tools/run.ts", content: "console.log('safe tool');" },
      { path: ".opencode/agents/reviewer.md", content: "agent" },
    ]);
  });
});
