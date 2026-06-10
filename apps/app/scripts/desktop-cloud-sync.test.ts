import { describe, expect, test } from "bun:test";

import {
  derivePendingCloudPluginChanges,
  readPendingCloudSyncChanges,
} from "../src/app/cloud/desktop-cloud-sync";
import type { OpenworkDesktopCloudSyncChange } from "../src/app/lib/openwork-server";

function change(input: Partial<OpenworkDesktopCloudSyncChange> & Pick<OpenworkDesktopCloudSyncChange, "id" | "kind" | "resourceKind">): OpenworkDesktopCloudSyncChange {
  return {
    marketplaceId: undefined,
    pluginId: undefined,
    previousLastUpdatedAt: null,
    nextLastUpdatedAt: null,
    queuedAt: 0,
    ...input,
  };
}

const installedPlugins = {
  "plugin-1": {
    updatedAt: "2026-01-01",
    files: [{ configObjectId: "obj-1", updatedAt: "2026-01-01" }],
  },
  "plugin-2": {
    updatedAt: "2026-01-01",
    files: [],
  },
};

describe("derivePendingCloudPluginChanges", () => {
  test("maps modified plugin changes to update available", () => {
    const pending = derivePendingCloudPluginChanges({
      changes: [
        change({ id: "plugin-1", kind: "modified", resourceKind: "plugin", nextLastUpdatedAt: "2026-02-01" }),
      ],
      installedPlugins,
    });
    expect(pending).toEqual({ "plugin-1": "modified" });
  });

  test("maps removed plugin changes to removed", () => {
    const pending = derivePendingCloudPluginChanges({
      changes: [
        change({ id: "plugin-2", kind: "removed", resourceKind: "plugin" }),
      ],
      installedPlugins,
    });
    expect(pending).toEqual({ "plugin-2": "removed" });
  });

  test("removed wins over config item modifications regardless of order", () => {
    const configItemChange = change({
      id: "obj-1",
      kind: "modified",
      resourceKind: "configItem",
      pluginId: "plugin-1",
      nextLastUpdatedAt: "2026-03-01",
    });
    const removedChange = change({ id: "plugin-1", kind: "removed", resourceKind: "plugin" });
    expect(derivePendingCloudPluginChanges({
      changes: [configItemChange, removedChange],
      installedPlugins,
    })).toEqual({ "plugin-1": "removed" });
    expect(derivePendingCloudPluginChanges({
      changes: [removedChange, configItemChange],
      installedPlugins,
    })).toEqual({ "plugin-1": "removed" });
  });

  test("config item changes mark the parent plugin as modified", () => {
    const pending = derivePendingCloudPluginChanges({
      changes: [
        change({
          id: "obj-1",
          kind: "modified",
          resourceKind: "configItem",
          pluginId: "plugin-1",
          nextLastUpdatedAt: "2026-04-01",
        }),
      ],
      installedPlugins,
    });
    expect(pending).toEqual({ "plugin-1": "modified" });
  });

  test("ignores changes for plugins that are not installed", () => {
    const pending = derivePendingCloudPluginChanges({
      changes: [
        change({ id: "plugin-gone", kind: "modified", resourceKind: "plugin", nextLastUpdatedAt: "2026-02-01" }),
        change({ id: "plugin-gone", kind: "removed", resourceKind: "plugin" }),
      ],
      installedPlugins,
    });
    expect(pending).toEqual({});
  });

  test("ignores stale changes already applied locally", () => {
    const pending = derivePendingCloudPluginChanges({
      changes: [
        change({ id: "plugin-1", kind: "modified", resourceKind: "plugin", nextLastUpdatedAt: "2026-01-01" }),
        change({
          id: "obj-1",
          kind: "modified",
          resourceKind: "configItem",
          pluginId: "plugin-1",
          nextLastUpdatedAt: "2026-01-01",
        }),
      ],
      installedPlugins,
    });
    expect(pending).toEqual({});
  });

  test("ignores other resource kinds", () => {
    const pending = derivePendingCloudPluginChanges({
      changes: [
        change({ id: "provider-1", kind: "modified", resourceKind: "llmProvider", nextLastUpdatedAt: "2026-02-01" }),
        change({ id: "marketplace-1", kind: "modified", resourceKind: "marketplace", nextLastUpdatedAt: "2026-02-01" }),
      ],
      installedPlugins,
    });
    expect(pending).toEqual({});
  });
});

describe("readPendingCloudSyncChanges", () => {
  test("reads pending changes from persisted sync state entries", () => {
    const changes = readPendingCloudSyncChanges({
      entries: {
        "org::member": {
          pendingChanges: [
            {
              id: "plugin-1",
              kind: "modified",
              resourceKind: "plugin",
              previousLastUpdatedAt: "2026-01-01",
              nextLastUpdatedAt: "2026-02-01",
              queuedAt: 1,
            },
            { id: "", kind: "modified", resourceKind: "plugin" },
            { id: "x", kind: "bogus", resourceKind: "plugin" },
            "not-a-change",
          ],
        },
        broken: null,
      },
      updatedAt: 1,
      version: 1,
    });
    expect(changes).toEqual([
      {
        id: "plugin-1",
        kind: "modified",
        resourceKind: "plugin",
        marketplaceId: undefined,
        pluginId: undefined,
        previousLastUpdatedAt: "2026-01-01",
        nextLastUpdatedAt: "2026-02-01",
        queuedAt: 1,
      },
    ]);
  });
});
