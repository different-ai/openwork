import { beforeEach, describe, expect, test } from "bun:test";

import type { DenExternalMcpConnection } from "../src/app/lib/den";
import {
  clearCloudInventoryCache,
  loadOrgMcpConnections,
  readCachedOrgMcpConnections,
  type OrgMcpConnectionClient,
} from "../src/react-app/domains/connections/cloud-inventory-cache";

const scope = { baseUrl: "https://den.example", organizationId: "org_1" };

function connection(id: string): DenExternalMcpConnection {
  return {
    id,
    organizationId: scope.organizationId,
    name: id,
    url: `https://${id}.example/mcp`,
    credentialMode: "per_member",
    connected: true,
    connectedForMe: true,
    status: "active",
  };
}

function countingClient(result: DenExternalMcpConnection[]) {
  let calls = 0;
  const client: OrgMcpConnectionClient = {
    listMcpConnections: async () => {
      calls += 1;
      return result;
    },
  };
  return { client, calls: () => calls };
}

describe("cloud inventory cache", () => {
  beforeEach(() => {
    clearCloudInventoryCache();
  });

  test("serves a fresh answer without going back to Den", async () => {
    const { client, calls } = countingClient([connection("notion")]);

    await loadOrgMcpConnections({ client, scope });
    await loadOrgMcpConnections({ client, scope });

    expect(calls()).toBe(1);
    expect(readCachedOrgMcpConnections(scope)?.map((entry) => entry.id)).toEqual(["notion"]);
  });

  test("shares one request between callers that ask at the same time", async () => {
    const { client, calls } = countingClient([connection("linear")]);

    await Promise.all([
      loadOrgMcpConnections({ client, scope }),
      loadOrgMcpConnections({ client, scope }),
    ]);

    expect(calls()).toBe(1);
  });

  test("refetches when the caller asks for a fresher answer", async () => {
    const { client, calls } = countingClient([connection("notion")]);

    await loadOrgMcpConnections({ client, scope });
    await loadOrgMcpConnections({ client, scope, maxAgeMs: 0 });

    expect(calls()).toBe(2);
  });

  test("keeps nothing for a different organization", async () => {
    const { client } = countingClient([connection("notion")]);

    await loadOrgMcpConnections({ client, scope });

    expect(readCachedOrgMcpConnections({ ...scope, organizationId: "org_2" })).toBeNull();
  });

  test("keeps the last good answer when a refresh fails", async () => {
    const { client } = countingClient([connection("notion")]);
    await loadOrgMcpConnections({ client, scope });

    const failing: OrgMcpConnectionClient = {
      listMcpConnections: async () => {
        throw new Error("den is down");
      },
    };
    await expect(loadOrgMcpConnections({ client: failing, scope, maxAgeMs: 0 })).rejects.toThrow("den is down");

    expect(readCachedOrgMcpConnections(scope)?.map((entry) => entry.id)).toEqual(["notion"]);
  });
});
