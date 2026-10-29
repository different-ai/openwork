import { describe, expect, test } from "bun:test";

import {
  buildDestinationOptions,
  destinationLabel,
} from "../src/react-app/domains/session/chat/new-task-destination-options";

const workspaces = [
  { id: "lounge", label: "openwork-lounge" },
  { id: "flow", label: "flow" },
  { id: "volumes", label: "freestyle-volumes" },
];
const groupsByWorkspace = {
  lounge: [{ id: "cw", label: "coworker" }, { id: "ti", label: "thread issues" }],
  flow: [{ id: "on", label: "onboarding" }],
};

function rows(input: Partial<Parameters<typeof buildDestinationOptions>[0]> = {}) {
  return buildDestinationOptions({
    destination: { workspaceId: "lounge", groupId: "cw" },
    workspaces,
    groupsByWorkspace,
    query: "",
    workspaceChangeBlocked: false,
    ...input,
  });
}

describe("new task destination", () => {
  test("the label names the workspace and the group", () => {
    expect(destinationLabel({ workspaceId: "lounge", groupId: "cw" }, workspaces, groupsByWorkspace)).toBe("openwork-lounge / coworker");
    expect(destinationLabel({ workspaceId: "flow" }, workspaces, groupsByWorkspace)).toBe("flow");
    expect(destinationLabel({ workspaceId: "flow", groupId: "gone" }, workspaces, groupsByWorkspace)).toBe("flow / Unavailable group");
  });

  test("lists each workspace with its groups under it and marks the current one", () => {
    expect(rows().map((row) => `${row.kind}:${row.label}${row.selected ? "*" : ""}`)).toEqual([
      "workspace:openwork-lounge",
      "group:coworker*",
      "group:thread issues",
      "workspace:flow",
      "group:onboarding",
      "workspace:freestyle-volumes",
    ]);
    expect(rows({ destination: { workspaceId: "volumes" } }).find((row) => row.selected)?.label).toBe("freestyle-volumes");
  });

  test("a query keeps a matching workspace whole, or matching groups under their workspace", () => {
    expect(rows({ query: "FLOW" }).map((row) => row.label)).toEqual(["flow", "onboarding"]);
    expect(rows({ query: "issues" }).map((row) => row.label)).toEqual(["openwork-lounge", "thread issues"]);
    expect(rows({ query: "nothing like this" })).toEqual([]);
  });

  test("a draft with workspace files can only change group within its workspace", () => {
    const blocked = rows({ workspaceChangeBlocked: true });
    expect(blocked.filter((row) => !row.disabled).map((row) => row.label)).toEqual(["openwork-lounge", "coworker", "thread issues"]);
  });

  test("a side chat stays in its parent's workspace", () => {
    const parent = { workspaceId: "flow", workspaceTitle: "flow", sessionId: "s1", title: "Parent" };
    expect(rows({ destination: { workspaceId: "flow", parent } }).map((row) => row.label)).toEqual(["flow", "onboarding"]);
  });
});
