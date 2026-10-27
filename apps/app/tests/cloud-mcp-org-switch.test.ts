import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DenMcpToken, DenMcpTokenMintContext } from "../src/app/lib/den";
import type { OpenworkCloudMcpHealth, OpenworkCloudMcpReconcilePayload } from "../src/app/lib/openwork-server";
import { runOpenworkCloudMcpReconciler, type CloudMcpClient } from "../src/react-app/domains/connections/cloud-mcp-reconciler";
import {
  __setCloudMcpUserStateStorageForTest,
  writeCloudMcpSyncMarker,
} from "../src/react-app/domains/connections/cloud-mcp-user-state";

const scope = {
  denBaseUrl: "https://den.example.test",
  serverBaseUrl: "http://127.0.0.1:8787",
  workspaceId: "workspace-1",
};

function health(organizationId: string): OpenworkCloudMcpHealth {
  return {
    usable: true,
    desired: {
      present: true,
      name: "openwork-cloud",
      revision: null,
      config: null,
      token: { present: true, metadata: { organizationId } },
      org: { id: organizationId },
    },
  } as OpenworkCloudMcpHealth;
}

function token(organizationId: string): DenMcpToken {
  return {
    token: `token-${organizationId}`,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    organizationId,
    scopes: ["mcp"],
    resource: "https://api.example.test/mcp",
  };
}

/** The workspace entry was last minted for `configuredOrgId`. */
function setup(configuredOrgId: string) {
  const minted: DenMcpTokenMintContext[] = [];
  const posted: OpenworkCloudMcpReconcilePayload[] = [];
  const client: CloudMcpClient = {
    baseUrl: scope.serverBaseUrl,
    getOpenworkCloudMcpHealth: async () => health(configuredOrgId),
    reconcileOpenworkCloudMcp: async (_workspaceId, payload) => {
      posted.push(payload);
      return health(String(payload.org?.id));
    },
  };
  const repair = (orgId: string) => runOpenworkCloudMcpReconciler({
    mode: "repair",
    client,
    context: { ...scope, orgId, denAuthToken: "session" },
    mintToken: async (context) => {
      minted.push(context);
      return context.orgId ? token(context.orgId) : null;
    },
    refreshMarginMs: 60_000,
  });
  return { minted, posted, repair };
}

beforeEach(() => {
  const values = new Map<string, string>();
  __setCloudMcpUserStateStorageForTest({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  });
});
afterEach(() => __setCloudMcpUserStateStorageForTest(null));

describe("cloud connection after an organization switch", () => {
  test("a working connection from the previous organization is replaced for the new one", async () => {
    const { minted, posted, repair } = setup("org-a");
    const result = await repair("org-b");
    expect(result.status).toBe("repaired");
    expect(minted.map((context) => context.orgId)).toEqual(["org-b"]);
    expect(posted.map((payload) => payload.org?.id)).toEqual(["org-b"]);
  });

  test("switching back to an organization used earlier replaces the other organization's connection", async () => {
    writeCloudMcpSyncMarker({ ...scope, orgId: "org-a", expiresAt: token("org-a").expiresAt });
    const { minted, repair } = setup("org-b");
    const result = await repair("org-a");
    expect(result.status).toBe("repaired");
    expect(minted.map((context) => context.orgId)).toEqual(["org-a"]);
  });

  test("a working connection for the current organization is left alone", async () => {
    const { minted, posted, repair } = setup("org-b");
    const result = await repair("org-b");
    expect(result.status).toBe("unchanged");
    expect(minted).toEqual([]);
    expect(posted).toEqual([]);
  });
});
