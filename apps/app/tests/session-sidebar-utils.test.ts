import { describe, expect, test } from "bun:test";

import type { SidebarSessionItem } from "../src/app/types";
import {
  buildSessionTreeState,
  flattenSessionRows,
  isActiveWorkSessionStatus,
  isNeedsAttentionSessionStatus,
  isStreamingSessionStatus,
} from "../src/react-app/domains/session/sidebar/utils";

const sessions: SidebarSessionItem[] = [
  { id: "session-a", title: "Pinned root" },
  { id: "session-a-child", title: "Pinned child", parentID: "session-a" },
  { id: "session-b", title: "Regular root" },
];

const statusCases: Array<{
  status: string | undefined;
  active: boolean;
  streaming: boolean;
  needsAttention: boolean;
}> = [
  ...["running", "busy", "retry", "streaming", "thinking", "responding", "compacting"]
    .map((status) => ({ status, active: true, streaming: true, needsAttention: false })),
  { status: "waiting", active: false, streaming: true, needsAttention: true },
  { status: "idle", active: false, streaming: false, needsAttention: false },
  { status: "unknown", active: false, streaming: false, needsAttention: false },
  { status: undefined, active: false, streaming: false, needsAttention: false },
];

describe("session sidebar statuses", () => {
  for (const { status, active, streaming, needsAttention } of statusCases) {
    test(`${status ?? "undefined"} maps to the expected sidebar indicators`, () => {
      expect(isActiveWorkSessionStatus(status)).toBe(active);
      expect(isStreamingSessionStatus(status)).toBe(streaming);
      expect(isNeedsAttentionSessionStatus(status)).toBe(needsAttention);
    });
  }
});

describe("global session pinning", () => {
  test("selects a pinned root and its expanded descendants", () => {
    const tree = buildSessionTreeState(sessions, undefined);
    const rows = flattenSessionRows(
      sessions,
      1,
      tree,
      new Set(["session-a"]),
      new Set(),
      new Set(["session-a"]),
      [],
      { include: new Set(["session-a"]) },
    );

    expect(rows.map((row) => row.session.id)).toEqual(["session-a", "session-a-child"]);
  });

  test("removes pinned roots before applying the workspace preview limit", () => {
    const tree = buildSessionTreeState(sessions, undefined);
    const rows = flattenSessionRows(
      sessions,
      1,
      tree,
      new Set(),
      new Set(),
      new Set(),
      [],
      { exclude: new Set(["session-a"]) },
    );

    expect(rows.map((row) => row.session.id)).toEqual(["session-b"]);
  });
});
