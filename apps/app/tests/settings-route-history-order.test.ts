import { expect, test } from "bun:test";
import { publishSettingsShellAndLoadHistory } from "@/react-app/shell/route-refresh-control";

test("the settings shell is available before a pending history load finishes", async () => {
  const events: string[] = [];
  const history = Promise.withResolvers<string>();
  const done = publishSettingsShellAndLoadHistory({
    isCurrent: () => true,
    publishShell: () => events.push("client and workspaces"),
    loadHistory: () => history.promise,
    publishHistory: (result) => events.push(result),
  });
  expect(events).toEqual(["client and workspaces"]);
  history.resolve("sessions");
  await done;
  expect(events).toEqual(["client and workspaces", "sessions"]);
});

test("a superseded history request cannot overwrite the new shell", async () => {
  const history = Promise.withResolvers<string>();
  let current = true;
  let published = false;
  const done = publishSettingsShellAndLoadHistory({ isCurrent: () => current, publishShell: () => {},
    loadHistory: () => history.promise, publishHistory: () => { published = true; } });
  current = false;
  history.resolve("old sessions");
  await done;
  expect(published).toBe(false);
});
