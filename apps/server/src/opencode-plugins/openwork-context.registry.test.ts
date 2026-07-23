import { afterEach, describe, expect, test } from "bun:test";

import { createOpenWorkCapabilitiesHooks } from "./lib/capabilities-knowledge.js";
import {
  describeContextRegistry,
  evaluateContextRegistryGates,
} from "./lib/context-registry.js";
import { OPENWORK_CONTEXT_REGISTRY } from "./lib/openwork-context-contributors.js";
import { createOpenWorkPreviewHooks } from "./lib/preview-context.js";
import { isRecord } from "./lib/records.js";
import { OpenWorkContext } from "./openwork-context.js";

const previousUiControlTools = process.env.OPENWORK_UI_CONTROL_TOOLS;

afterEach(() => {
  if (previousUiControlTools === undefined) delete process.env.OPENWORK_UI_CONTROL_TOOLS;
  else process.env.OPENWORK_UI_CONTROL_TOOLS = previousUiControlTools;
});

describe("OpenWork consolidated context registry", () => {
  test("declares contributor order, kinds, gates, and cache policies explicitly", () => {
    expect(describeContextRegistry(OPENWORK_CONTEXT_REGISTRY).map((contributor) => ({
      id: contributor.id,
      order: contributor.order,
      kind: contributor.kind,
      gate: contributor.gate,
      gateEnv: contributor.gateEnv,
      cache: contributor.cache,
    }))).toEqual([
      { id: "connect-steering", order: 10, kind: "system-block", gate: "always", gateEnv: [], cache: { scope: "none" } },
      { id: "connect-skills", order: 20, kind: "system-block", gate: "always", gateEnv: [], cache: { scope: "none" } },
      { id: "session-creation", order: 30, kind: "system-block", gate: "always", gateEnv: [], cache: { scope: "process" } },
      { id: "session-memory", order: 40, kind: "system-block", gate: "always", gateEnv: [], cache: { scope: "process" } },
      { id: "browser-guidance", order: 50, kind: "system-block", gate: "always", gateEnv: [], cache: { scope: "process" } },
      { id: "ui-control-guidance", order: 60, kind: "system-block", gate: "contributor-env", gateEnv: ["OPENWORK_UI_CONTROL_TOOLS"], cache: { scope: "process" } },
      { id: "capabilities-knowledge", order: 70, kind: "system-block", gate: "always", gateEnv: [], cache: { scope: "process" } },
      { id: "extension-tools", order: 100, kind: "tool", gate: "always", gateEnv: [], cache: { scope: "none" } },
      { id: "ui-control-tools", order: 110, kind: "tool", gate: "contributor-env", gateEnv: ["OPENWORK_UI_CONTROL_TOOLS"], cache: { scope: "none" } },
      { id: "session-tools", order: 120, kind: "tool", gate: "always", gateEnv: [], cache: { scope: "none" } },
      { id: "extensions-export-tool", order: 130, kind: "tool", gate: "always", gateEnv: [], cache: { scope: "none" } },
      { id: "browser-tools", order: 140, kind: "tool", gate: "always", gateEnv: [], cache: { scope: "none" } },
      { id: "docs-tools", order: 150, kind: "tool", gate: "always", gateEnv: [], cache: { scope: "process" } },
      { id: "office-attachments", order: 200, kind: "messages", gate: "always", gateEnv: [], cache: { scope: "none" } },
      { id: "adaptive-thinking", order: 210, kind: "params", gate: "always", gateEnv: [], cache: { scope: "none" } },
      { id: "anthropic-tool-schema", order: 220, kind: "fetch-patch", gate: "always", gateEnv: [], cache: { scope: "process" } },
    ]);
  });

  test("keeps helper factories tools-only so registry resolution is the sole context path", () => {
    expect(Object.keys(createOpenWorkPreviewHooks())).toEqual(["tool"]);
    expect(Object.keys(createOpenWorkCapabilitiesHooks())).toEqual(["tool"]);
  });

  test("declares exact tool provenance and matches the tools exposed by current gates", async () => {
    const descriptions = describeContextRegistry(OPENWORK_CONTEXT_REGISTRY);
    const toolNamesByContributor = Object.fromEntries(
      descriptions
        .filter((contributor) => contributor.kind === "tool")
        .map((contributor) => [contributor.id, contributor.toolNames]),
    );
    expect(toolNamesByContributor).toEqual({
      "extension-tools": [
        "openwork_extension_list_actions",
        "openwork_extension_call",
      ],
      "ui-control-tools": [
        "openwork_ui_snapshot",
        "openwork_ui_list_actions",
        "openwork_ui_execute_action",
      ],
      "session-tools": [
        "openwork_session_create",
        "openwork_session_search",
        "openwork_session_read",
      ],
      "extensions-export-tool": ["openwork_extensions_export"],
      "browser-tools": [
        "openwork_browser_open_url",
        "openwork_browser_set_proxy",
        "openwork_browser_clear_proxy",
      ],
      "docs-tools": ["openwork_docs_search", "openwork_docs_read"],
    });

    for (const uiControlTools of ["0", "1"]) {
      process.env.OPENWORK_UI_CONTROL_TOOLS = uiControlTools;
      const gates = evaluateContextRegistryGates(OPENWORK_CONTEXT_REGISTRY, {
        env: { ...process.env },
        factoryContext: {},
      });
      const enabled = new Set(gates.filter((gate) => gate.enabled).map((gate) => gate.id));
      const expected = descriptions
        .filter((contributor) => contributor.kind === "tool" && enabled.has(contributor.id))
        .flatMap((contributor) => contributor.toolNames)
        .sort();
      const hooks = await OpenWorkContext();

      expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(expected);
    }
  });

  test("exposes one runtime plugin factory and builds only active entrypoints", async () => {
    const contextModule = await import("./openwork-context.js");
    expect(Object.keys(contextModule)).toEqual(["OpenWorkContext"]);

    const packageJson: unknown = await Bun.file(new URL("../../package.json", import.meta.url)).json();
    if (!isRecord(packageJson) || !isRecord(packageJson.scripts) || typeof packageJson.scripts.build !== "string") {
      throw new Error("Expected the server package build script");
    }
    expect(packageJson.scripts.build).toContain("dist/opencode-plugin-bundles");
    expect(packageJson.scripts.build).toContain("import('./dist/embedded.js')");
    expect(packageJson.scripts.build).toContain("check-built-observability.mjs");
    expect(packageJson.scripts.build).toContain("src/opencode-plugins/openwork-context.ts");
    expect(packageJson.scripts.build).toContain("src/opencode-plugins/openwork-prompt-log.ts");
    expect(packageJson.scripts.build).not.toMatch(/openwork-(?:extensions-preview|capabilities-knowledge|office-attachments|anthropic-adaptive-thinking|anthropic-tool-schema)\.ts/);
  });
});
