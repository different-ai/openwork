import { describe, expect, test } from "bun:test";

import {
  workspaceAvatarColor,
  workspaceAvatarInitials,
} from "../src/react-app/design-system/workspace-avatar-utils";
import {
  SIDEBAR_ROW_BASE_PAD_PX,
  SIDEBAR_ROW_NEST_STEP_PX,
  sidebarRowPaddingInlineStart,
} from "../src/react-app/domains/session/sidebar/sidebar-lane-metrics";

describe("workspaceAvatarInitials", () => {
  test("uses two letters from multi-word labels", () => {
    expect(workspaceAvatarInitials("new-folder")).toBe("NF");
    expect(workspaceAvatarInitials("Open Work")).toBe("OW");
  });

  test("uses up to two characters from a single token", () => {
    expect(workspaceAvatarInitials("alpha")).toBe("AL");
    expect(workspaceAvatarInitials("x")).toBe("X");
  });

  test("falls back for empty labels", () => {
    expect(workspaceAvatarInitials("   ")).toBe("?");
  });
});

describe("workspaceAvatarColor", () => {
  test("is stable for the same workspace id", () => {
    expect(workspaceAvatarColor("ws_abc")).toBe(workspaceAvatarColor("ws_abc"));
  });

  test("varies across different workspace ids", () => {
    expect(workspaceAvatarColor("ws_a")).not.toBe(workspaceAvatarColor("ws_zzzz"));
  });
});

describe("sidebarRowPaddingInlineStart", () => {
  test("steps 16px per depth level", () => {
    expect(sidebarRowPaddingInlineStart(0)).toBe(SIDEBAR_ROW_BASE_PAD_PX);
    expect(sidebarRowPaddingInlineStart(1)).toBe(SIDEBAR_ROW_BASE_PAD_PX + SIDEBAR_ROW_NEST_STEP_PX);
    expect(sidebarRowPaddingInlineStart(2)).toBe(SIDEBAR_ROW_BASE_PAD_PX + 2 * SIDEBAR_ROW_NEST_STEP_PX);
    expect(SIDEBAR_ROW_NEST_STEP_PX).toBe(16);
  });

  test("clamps negative depth to the base lane", () => {
    expect(sidebarRowPaddingInlineStart(-3)).toBe(SIDEBAR_ROW_BASE_PAD_PX);
  });
});

describe("resolveWorkspaceAvatarColor", () => {
  test("uses a preferred hex color when valid", async () => {
    const { resolveWorkspaceAvatarColor } = await import(
      "../src/react-app/design-system/workspace-avatar-utils"
    );
    expect(resolveWorkspaceAvatarColor("ws_a", "#E23B4C")).toBe("#E23B4C");
  });

  test("falls back to autoset color for invalid preferred values", async () => {
    const { resolveWorkspaceAvatarColor, workspaceAvatarColor } = await import(
      "../src/react-app/design-system/workspace-avatar-utils"
    );
    expect(resolveWorkspaceAvatarColor("ws_a", "nope")).toBe(workspaceAvatarColor("ws_a"));
  });
});
