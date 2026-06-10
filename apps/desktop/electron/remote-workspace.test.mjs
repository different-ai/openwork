import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  discoverOpenworkWorkspace,
  fetchOpenworkWorkspaceList,
  openworkWorkspaceDiscoveryHeaders,
  openworkWorkspaceDisplayName,
  selectOpenworkWorkspaceForConnection,
} from "./remote-workspace.mjs";

describe("selectOpenworkWorkspaceForConnection", () => {
  it("selects the active worker workspace when no directory is provided", () => {
    const selected = selectOpenworkWorkspaceForConnection(
      {
        activeId: "ws_active",
        items: [
          { id: "ws_first", path: "/workspace/first" },
          { id: "ws_active", path: "/workspace/active" },
        ],
      },
      null,
    );

    assert.equal(selected?.id, "ws_active");
  });

  it("falls back to the first workspace when activeId is missing", () => {
    const selected = selectOpenworkWorkspaceForConnection(
      {
        items: [
          { id: "ws_first", path: "/workspace/first" },
          { id: "ws_second", path: "/workspace/second" },
        ],
      },
      "",
    );

    assert.equal(selected?.id, "ws_first");
  });

  it("selects a workspace whose path matches the requested remote directory", () => {
    const selected = selectOpenworkWorkspaceForConnection(
      {
        activeId: "ws_other",
        items: [
          { id: "ws_other", path: "/workspace/other" },
          { id: "ws_demo", path: "/home/user/workspaces/demo" },
        ],
      },
      "/home/user/workspaces/demo/",
    );

    assert.equal(selected?.id, "ws_demo");
  });

  it("selects by opencode directory when workers expose it there", () => {
    const selected = selectOpenworkWorkspaceForConnection(
      {
        items: [
          {
            id: "ws_demo",
            path: "/workspace",
            opencode: { directory: "/home/user/workspaces/demo" },
          },
        ],
      },
      "/home/user/workspaces/demo",
    );

    assert.equal(selected?.id, "ws_demo");
  });

  it("returns null when a requested directory is not present", () => {
    const selected = selectOpenworkWorkspaceForConnection(
      { items: [{ id: "ws_demo", path: "/workspace/demo" }] },
      "/workspace/missing",
    );

    assert.equal(selected, null);
  });

  it("reads legacy workspaces arrays", () => {
    const selected = selectOpenworkWorkspaceForConnection(
      { activeId: "ws_legacy", workspaces: [{ id: "ws_legacy", path: "/workspace" }] },
      null,
    );

    assert.equal(selected?.id, "ws_legacy");
  });
});

describe("openworkWorkspaceDisplayName", () => {
  it("prefers display fields before id", () => {
    assert.equal(
      openworkWorkspaceDisplayName({
        id: "ws_demo",
        name: "Worker project",
        displayName: "Demo",
      }),
      "Demo",
    );
  });
});

describe("OpenWork workspace discovery client", () => {
  it("builds normal discovery headers with bearer auth only", () => {
    const headers = openworkWorkspaceDiscoveryHeaders("remote-client-token");

    assert.equal(headers.get("Authorization"), "Bearer remote-client-token");
    assert.equal(headers.has("X-OpenWork-Host-Token"), false);
  });

  it("does not expose host token input on discovery API surface", async () => {
    const requests = [];
    const discovered = await discoverOpenworkWorkspace({
      hostUrl: "https://worker.example.test",
      token: "remote-client-token",
      directory: "/workspace/project",
      fetchImpl: async (url, init) => {
        requests.push({ url, headers: init.headers });
        return Response.json({
          items: [{ id: "ws_project", name: "Project", path: "/workspace/project" }],
        });
      },
    });

    assert.equal(discovered?.id, "ws_project");
    assert.equal(requests[0].url, "https://worker.example.test/workspaces");
    assert.equal(requests[0].headers.get("Authorization"), "Bearer remote-client-token");
    assert.equal(requests[0].headers.has("X-OpenWork-Host-Token"), false);
  });

  it("uses the normal client path for workspace list fetches", async () => {
    const list = await fetchOpenworkWorkspaceList("https://worker.example.test/", "remote-client-token", {
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers.get("Authorization"), "Bearer remote-client-token");
        assert.equal(init.headers.get("X-OpenWork-Host-Token"), null);
        return Response.json({ items: [] });
      },
    });

    assert.deepEqual(list, { items: [] });
  });
});
