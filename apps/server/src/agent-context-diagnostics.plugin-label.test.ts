import { describe, expect, test } from "bun:test";

import { pluginLabel } from "./agent-context-diagnostics.js";

describe("agent context diagnostics plugin labels", () => {
  test("keeps only the safe pathname label from hierarchical URLs", () => {
    const labels = [
      pluginLabel(
        "https://URL_USER_CANARY:URL_PASSWORD_CANARY@plugins.example.test/releases/signed-plugin.js?X-Amz-Signature=SIGNED_QUERY_CANARY#SIGNED_FRAGMENT_CANARY",
      ),
      pluginLabel("https://plugins.example/download?X-Amz-Signature=TOPSECRET_QUERY_CANARY"),
      pluginLabel("file:///private/plugins/local-plugin.ts?token=FILE_QUERY_CANARY#FILE_FRAGMENT_CANARY"),
    ];

    expect(labels).toEqual(["signed-plugin", "download", "local-plugin"]);
    const serialized = JSON.stringify(labels);
    for (const canary of [
      "URL_USER_CANARY",
      "URL_PASSWORD_CANARY",
      "SIGNED_QUERY_CANARY",
      "SIGNED_FRAGMENT_CANARY",
      "TOPSECRET_QUERY_CANARY",
      "FILE_QUERY_CANARY",
      "FILE_FRAGMENT_CANARY",
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  test("fails closed for malformed and opaque URL-like specs", () => {
    expect(pluginLabel("https://[malformed.example/plugin.js?token=MALFORMED_QUERY_CANARY")).toBe(
      "[redacted-sensitive-label]",
    );
    expect(pluginLabel("https://plugins.example/%ZZ?token=MALFORMED_PATH_QUERY_CANARY")).toBe(
      "[redacted-sensitive-label]",
    );
    expect(pluginLabel("data:text/javascript,OPAQUE_PLUGIN_CANARY")).toBe("[redacted-sensitive-label]");
    expect(pluginLabel("mailto:OPAQUE_NO_SLASH_CANARY")).toBe("[redacted-sensitive-label]");
  });
});
