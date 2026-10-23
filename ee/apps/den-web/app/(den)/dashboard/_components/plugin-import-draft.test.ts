import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getImportedPluginCreateRoute, getNewPluginRoute } from "../../_lib/den-org";
import {
  clearPluginImportDraft,
  importedPluginCreateBody,
  loadPluginImportDraft,
  newPluginPageUsesEditor,
  savePluginImportDraft,
  type PluginImportDraft,
} from "./plugin-import-draft";

type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

class MemoryStorage implements SessionStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const globalWithWindow: { window?: { sessionStorage: SessionStorage } } = globalThis;

afterEach(() => {
  delete globalWithWindow.window;
});

const draft: PluginImportDraft = {
  version: 1,
  authType: "oauth",
  credentialMode: "per_member",
  githubUrl: "https://github.com/example-org/example-plugins/tree/main/legal",
  preview: {
    repositoryFullName: "example-org/example-plugins",
    rootPath: "legal",
    servers: [
      { name: "Docs", serverKey: "docs", url: "https://mcp.example.test/mcp", supported: true, skippedReason: null, mapsToName: null, reuseConnectionName: null },
      { name: "Local", serverKey: "local", url: null, supported: false, skippedReason: "local_unsupported", mapsToName: null, reuseConnectionName: null },
    ],
    skills: [
      { name: "Review contract", skillKey: "skills/review-contract", description: "Reviews a contract", sourcePath: "skills/review-contract/SKILL.md", supported: true, skippedReason: null },
      { name: "Triage NDA", skillKey: "skills/triage-nda", description: null, sourcePath: "skills/triage-nda/SKILL.md", supported: true, skippedReason: null },
    ],
    warnings: [],
  },
  selectedServerKeys: ["docs"],
  selectedSkillKeys: ["skills/review-contract", "skills/triage-nda"],
};

test("Continue to create lands on the screen that reads the import draft", () => {
  const continueRoute = new URL(getImportedPluginCreateRoute("acme"), "https://den.example.test");
  assert.equal(continueRoute.pathname, getNewPluginRoute("acme"));
  assert.equal(newPluginPageUsesEditor(Object.fromEntries(continueRoute.searchParams)), true);
  assert.equal(newPluginPageUsesEditor({ marketplaceId: "mkt_1" }), true);
  // The plain create form (no import draft support) stays the default.
  assert.equal(newPluginPageUsesEditor({}), false);
});

test("the saved import draft survives navigation and becomes the create request", () => {
  globalWithWindow.window = { sessionStorage: new MemoryStorage() };
  savePluginImportDraft(draft);

  const loaded = loadPluginImportDraft();
  assert.ok(loaded, "the create screen should find the import draft");
  assert.deepEqual(loaded.preview.skills.map((skill) => skill.name), ["Review contract", "Triage NDA"]);
  assert.deepEqual(loaded.preview.servers.map((server) => server.name), ["Docs"]);

  const body = importedPluginCreateBody(loaded, {
    name: "  Legal  ",
    description: "",
    marketplaceId: "",
    access: { orgWide: true, memberIds: [], teamIds: [] },
  });
  assert.deepEqual(body, {
    access: { orgWide: true, memberIds: [], teamIds: [] },
    authType: "oauth",
    credentialMode: "per_member",
    description: null,
    githubUrl: draft.githubUrl,
    marketplaceId: undefined,
    name: "Legal",
    selectedSkillKeys: ["skills/review-contract", "skills/triage-nda"],
    selectedServerKeys: ["docs"],
  });

  clearPluginImportDraft();
  assert.equal(loadPluginImportDraft(), null);
});
