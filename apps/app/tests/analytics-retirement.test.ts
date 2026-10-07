import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readActiveWorkspaceId } from "../src/react-app/shell/session-memory";
import { createInitialWorkspaceLocalState } from "../src/react-app/domains/workspace/create-workspace-modal-state";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
beforeEach(() => window.localStorage.clear());
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

test("retiring project analytics clears its labels without losing workspace navigation or credentials", () => {
  window.localStorage.setItem("openwork.react.workspaceProjectDimension", JSON.stringify({ ws: { label: "Legacy project" } }));
  window.localStorage.setItem("openwork.react.activeWorkspace", "ws");
  window.localStorage.setItem("openwork.react.sessionByWorkspace", JSON.stringify({ ws: "session" }));
  window.localStorage.setItem("openwork.server.token", "synthetic-local-token");
  expect(readActiveWorkspaceId()).toBe("ws");
  expect(window.localStorage.getItem("openwork.react.workspaceProjectDimension")).toBeNull();
  expect(window.localStorage.getItem("openwork.react.sessionByWorkspace")).toBe(JSON.stringify({ ws: "session" }));
  expect(window.localStorage.getItem("openwork.server.token")).toBe("synthetic-local-token");
});

test("workspace creation no longer carries a project analytics field", () => {
  expect(createInitialWorkspaceLocalState()).not.toHaveProperty("projectLabel");
});
