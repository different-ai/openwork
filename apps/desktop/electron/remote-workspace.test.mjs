import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isDesktopFetchAllowedForDenBootstrap,
  isDesktopFetchAllowedForWorkspaces,
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

describe("isDesktopFetchAllowedForWorkspaces", () => {
  const workspaces = [
    {
      workspaceType: "remote",
      baseUrl: "https://worker.example.com/w/rem_ws_123",
      openworkHostUrl: "https://worker.example.com",
    },
    { workspaceType: "local", baseUrl: "https://ignored.example.com" },
  ];

  it("allows configured remote workspace origins", () => {
    assert.equal(isDesktopFetchAllowedForWorkspaces("https://worker.example.com/workspaces", workspaces), true);
  });

  it("rejects unconfigured origins and non-HTTP protocols", () => {
    assert.equal(isDesktopFetchAllowedForWorkspaces("https://attacker.example.com/workspaces", workspaces), false);
    assert.equal(isDesktopFetchAllowedForWorkspaces("file:///etc/passwd", workspaces), false);
  });
});

describe("isDesktopFetchAllowedForDenBootstrap", () => {
  it("allows configured Den web and API origins before a workspace exists", () => {
    const bootstrap = {
      baseUrl: "https://den.company.local",
      apiBaseUrl: "https://den-api.company.local",
    };

    assert.equal(isDesktopFetchAllowedForDenBootstrap("https://den.company.local/api/auth/get-session", bootstrap), true);
    assert.equal(isDesktopFetchAllowedForDenBootstrap("https://den-api.company.local/v1/workers", bootstrap), true);
  });

  it("rejects unconfigured Den origins and non-HTTP protocols", () => {
    const bootstrap = { baseUrl: "https://den.company.local", apiBaseUrl: null };

    assert.equal(isDesktopFetchAllowedForDenBootstrap("https://attacker.example.com/v1/workers", bootstrap), false);
    assert.equal(isDesktopFetchAllowedForDenBootstrap("file:///etc/passwd", bootstrap), false);
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
