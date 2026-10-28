import { expect, test } from "bun:test";

import { toSessionGroups, type RouteWorkspace } from "../src/react-app/shell/route-workspaces";

const workspace: RouteWorkspace = { id: "one", name: "one", displayNameResolved: "one", path: "/tmp/one", preset: "starter", workspaceType: "local" };

test("a task list that failed to load is an error, not an empty list", () => {
  const [group] = toSessionGroups([workspace], {}, {}, new Set(), { one: "Engine is starting" });
  expect(group.status).toBe("error");
  expect(group.error).toBe("Engine is starting");
});

test("loading wins over a previous failure while the list is read again", () => {
  const [group] = toSessionGroups([workspace], {}, {}, new Set(["one"]), { one: "Engine is starting" });
  expect(group.status).toBe("loading");
});

test("a workspace connection error keeps precedence over a task list failure", () => {
  const [group] = toSessionGroups([workspace], {}, { one: "Disconnected" }, new Set(), { one: "Engine is starting" });
  expect(group.error).toBe("Disconnected");
});

test("a loaded empty list is ready", () => {
  const [group] = toSessionGroups([workspace], { one: [] }, {}, new Set());
  expect(group.status).toBe("ready");
});
