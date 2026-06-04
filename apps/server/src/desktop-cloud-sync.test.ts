import { describe, expect, test } from "bun:test";
import {
  readDesktopCloudSyncState,
  syncDesktopCloudResources,
  type ResourceSnapshot,
} from "./desktop-cloud-sync.js";

const baseSnapshot: ResourceSnapshot = {
  organizationId: "org_1",
  orgMemberId: "member_1",
  teamIds: [],
  resources: {
    llmProviders: {
      lpr_existing: "2026-06-02T00:00:00.000Z",
      lpr_new: "2026-06-02T00:00:00.000Z",
    },
    marketplaces: {},
  },
};

describe("desktop cloud sync", () => {
  test("queues provider update and remove changes", () => {
    const openwork = {
      cloudImports: {
        providers: {
          lpr_existing: {
            cloudProviderId: "lpr_existing",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
          lpr_removed: {
            cloudProviderId: "lpr_removed",
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
        },
      },
    };

    const result = syncDesktopCloudResources({ now: 1780442400000, openwork, snapshot: baseSnapshot });

    expect(result.changes).toEqual([
      {
        id: "lpr_existing",
        kind: "modified",
        resourceKind: "llmProvider",
        previousLastUpdatedAt: "2026-06-01T00:00:00.000Z",
        nextLastUpdatedAt: "2026-06-02T00:00:00.000Z",
        queuedAt: 1780442400000,
      },
      {
        id: "lpr_removed",
        kind: "removed",
        resourceKind: "llmProvider",
        previousLastUpdatedAt: "2026-06-01T00:00:00.000Z",
        nextLastUpdatedAt: null,
        queuedAt: 1780442400000,
      },
    ]);

    const state = readDesktopCloudSyncState(result.openwork);
    expect(state.entries["org_1::member_1"]?.pendingChanges).toHaveLength(2);
  });

  test("syncs large provider snapshots within an interactive budget", () => {
    const providerCount = 1_000;
    const llmProviders = Object.fromEntries(
      Array.from({ length: providerCount }, (_, index) => [
        `lpr_provider_${index}`,
        "2026-06-02T00:00:00.000Z",
      ]),
    );
    const importedProviders = Object.fromEntries(
      Array.from({ length: providerCount }, (_, index) => [
        `lpr_provider_${index}`,
        {
          cloudProviderId: `lpr_provider_${index}`,
          updatedAt: index % 2 === 0 ? "2026-06-01T00:00:00.000Z" : "2026-06-02T00:00:00.000Z",
        },
      ]),
    );
    const snapshot: ResourceSnapshot = {
      organizationId: "org_perf",
      orgMemberId: "member_perf",
      teamIds: [],
      resources: { llmProviders, marketplaces: {} },
    };
    const openwork = { cloudImports: { providers: importedProviders } };

    const start = performance.now();
    const result = syncDesktopCloudResources({ now: 1780442400000, openwork, snapshot });
    const elapsedMs = performance.now() - start;

    expect(result.changes).toHaveLength(providerCount / 2);
    expect(elapsedMs).toBeLessThan(50);
  });
});
