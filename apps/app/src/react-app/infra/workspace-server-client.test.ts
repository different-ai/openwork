declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  not: { toBe: (expected: unknown) => void };
};

import {
  createWorkspaceServerClientCacheKey,
  createWorkspaceServerClientResolver,
  createWorkspaceServerClientResolverState,
  type WorkspaceServerClientWorkspace,
} from "./workspace-server-client";

const localWorkspace: WorkspaceServerClientWorkspace = {
  id: "local-alpha",
  workspaceType: "local",
};

const remoteWorkspace: WorkspaceServerClientWorkspace = {
  id: "rem_local-id",
  workspaceType: "remote",
  baseUrl: "https://worker.example.test",
  openworkToken: "remote-token",
  openworkWorkspaceId: "server-workspace-id",
};

describe("workspace server client primitive", () => {
  test("equivalent route refreshes retain local and fallback endpoint identities", () => {
    const server = { baseUrl: "http://127.0.0.1:4096", token: "local-token" };
    const state = createWorkspaceServerClientResolverState(server);
    const first = state.resolve(localWorkspace);
    const fallback = state.resolve(remoteWorkspace);
    if (!first || !fallback) throw new Error("Expected workspace endpoints.");
    for (let index = 0; index < 3; index++) {
      const refreshed = state.update({ baseUrl: ` ${server.baseUrl} `, token: ` ${server.token} ` });
      expect(refreshed({ ...localWorkspace })).toBe(first);
      expect(refreshed({ ...remoteWorkspace })).toBe(fallback);
      expect(state.resolve(localWorkspace)?.client).toBe(first.client);
    }
  });

  test("route refreshes still invalidate changed addresses and credentials", () => {
    const server = { baseUrl: "http://127.0.0.1:4096", token: "local-token-a" };
    const state = createWorkspaceServerClientResolverState(server);
    const first = state.resolve(localWorkspace);
    const changedToken = state.update({ ...server, token: "local-token-b" })(localWorkspace);
    const changedAddress = state.update({ baseUrl: "http://127.0.0.1:5096", token: "local-token-b" })(localWorkspace);
    if (!first || !changedToken || !changedAddress) throw new Error("Expected workspace endpoints.");
    expect(changedToken.client).not.toBe(first.client);
    expect(changedToken.token).toBe("local-token-b");
    expect(changedAddress.client).not.toBe(changedToken.client);
    expect(changedAddress.baseUrl).toBe("http://127.0.0.1:5096");
    const otherState = createWorkspaceServerClientResolverState(server);
    expect(otherState.resolve(localWorkspace)?.client).not.toBe(first.client);
  });

  test("memoizes local workspace endpoints by selected local server credentials", () => {
    const resolver = createWorkspaceServerClientResolver({
      baseUrl: " http://127.0.0.1:4096 ",
      token: " local-token ",
    });

    const first = resolver(localWorkspace);
    const repeated = resolver(localWorkspace);
    if (!first || !repeated) throw new Error("Expected a local workspace endpoint.");

    expect(repeated).toBe(first);
    expect(repeated.client).toBe(first.client);
    expect(first.baseUrl).toBe("http://127.0.0.1:4096");
    expect(first.token).toBe("local-token");
    expect(first.workspaceId).toBe("local-alpha");
    expect(first.opencodeBaseUrl).toBe("http://127.0.0.1:4096/workspace/local-alpha/opencode");
  });

  test("changed local credentials produce a distinct endpoint and client", () => {
    const firstResolver = createWorkspaceServerClientResolver({
      baseUrl: "http://127.0.0.1:4096",
      token: "local-token-a",
    });
    const changedResolver = createWorkspaceServerClientResolver({
      baseUrl: "http://127.0.0.1:4096",
      token: "local-token-b",
    });

    const first = firstResolver(localWorkspace);
    const changed = changedResolver(localWorkspace);
    if (!first || !changed) throw new Error("Expected local workspace endpoints.");

    expect(changed).not.toBe(first);
    expect(changed.client).not.toBe(first.client);
    expect(first.token).toBe("local-token-a");
    expect(changed.token).toBe("local-token-b");
  });

  test("keys remote workspace endpoints from the owning worker, not the local server", () => {
    const localKey = createWorkspaceServerClientCacheKey(remoteWorkspace, {
      baseUrl: "http://127.0.0.1:4096",
      token: "local-token-a",
    });
    const changedLocalKey = createWorkspaceServerClientCacheKey(remoteWorkspace, {
      baseUrl: "http://127.0.0.1:5096",
      token: "local-token-b",
    });
    const resolver = createWorkspaceServerClientResolver({
      baseUrl: "http://127.0.0.1:4096",
      token: "local-token-a",
    });

    const endpoint = resolver(remoteWorkspace);
    if (!endpoint) throw new Error("Expected a remote workspace endpoint.");

    expect(changedLocalKey).toBe(localKey);
    expect(endpoint.baseUrl).toBe("https://worker.example.test");
    expect(endpoint.token).toBe("remote-token");
    expect(endpoint.workspaceId).toBe("server-workspace-id");
    expect(endpoint.opencodeBaseUrl).toBe("https://worker.example.test/workspace/server-workspace-id/opencode");
  });

  test("keeps resolver caches scoped instead of leaking a global singleton", () => {
    const firstResolver = createWorkspaceServerClientResolver({
      baseUrl: "http://127.0.0.1:4096",
      token: "local-token",
    });
    const secondResolver = createWorkspaceServerClientResolver({
      baseUrl: "http://127.0.0.1:4096",
      token: "local-token",
    });

    const first = firstResolver(localWorkspace);
    const second = secondResolver(localWorkspace);
    if (!first || !second) throw new Error("Expected local workspace endpoints.");

    expect(first).not.toBe(second);
    expect(first.client).not.toBe(second.client);
  });
});
