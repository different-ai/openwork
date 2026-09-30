import { expect, test } from "bun:test";

import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import type { OpenworkServerClient } from "../src/app/lib/openwork-server";
import type { Client } from "../src/app/types";
import { readManagedDisabledProviders } from "../src/react-app/domains/connections/managed-engine-config";

function serverClient(disabledProviders: string[], reads: string[]) {
  const client: Pick<OpenworkServerClient, "getRuntimeDisabledProviders"> = {
    getRuntimeDisabledProviders: async (workspaceId: string) => {
      reads.push(workspaceId);
      return { ok: true, disabledProviders };
    },
  };
  // Only the one method this path calls is implemented.
  return client as OpenworkServerClient;
}

test("OpenCode v2 reads disabled providers from the OpenWork server, not its private engine config", async () => {
  const reads: string[] = [];
  const originalFetch = globalThis.fetch;
  let engineRequests = 0;
  globalThis.fetch = async () => {
    engineRequests += 1;
    return new Response("{}", { status: 403 });
  };
  try {
    const v2 = createClientV2("http://localhost/opencode2", "/workspace", {});
    expect(await readManagedDisabledProviders({
      opencodeClient: v2,
      openworkClient: serverClient(["opencode", " opencode ", "litellm"], reads),
      workspaceId: "ws_1",
      workspaceType: "local",
    })).toEqual(["opencode", "litellm"]);
    expect(reads).toEqual(["ws_1"]);
    expect(engineRequests).toBe(0);

    // Without an OpenWork server there is no source of truth; never invent one.
    expect(await readManagedDisabledProviders({ opencodeClient: v2, workspaceId: "ws_1", workspaceType: "local" })).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenCode v1 keeps reading disabled providers from engine config", async () => {
  const reads: string[] = [];
  const v1 = {
    config: { get: async () => ({ data: { disabled_providers: ["opencode"] } }) },
  } as unknown as Client;
  expect(await readManagedDisabledProviders({
    opencodeClient: v1,
    openworkClient: serverClient(["other"], reads),
    workspaceId: "ws_1",
    workspaceType: "local",
  })).toEqual(["opencode"]);
  expect(reads).toEqual([]);
});
