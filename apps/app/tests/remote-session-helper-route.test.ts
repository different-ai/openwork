import { expect, test } from "bun:test"
import { consumeChildReturn, prepareChildReturn, registerChildDraftPersistence, rememberChildOrigin } from "../src/lib/child-navigation"
import { isRemoteSessionRouteId, remoteSessionRouteId, remoteThreadKeyFromRouteId } from "../src/lib/remote-session-route"
import {
  parseRemoteHelperOrigin,
  rememberRemoteHelperOrigin,
  remoteHelperOrigin,
} from "../src/react-app/domains/session/remote-threads/remote-helper-navigation"
import { workspaceSessionRoute } from "../src/react-app/shell/workspace-routes"
import { openWorkbenchTab, setWorkbenchSideChat, syncWorkbenchSnapshot, type WorkbenchSnapshot } from "../src/react-app/domains/session/chat/workbench-store"

test("a task on another computer gets its own session route that is never a local session id", () => {
  const id = remoteSessionRouteId("command:rsc_01abc")
  expect(id).toBe("remote:command:rsc_01abc")
  expect(remoteThreadKeyFromRouteId(id)).toBe("command:rsc_01abc")
  expect(remoteThreadKeyFromRouteId("remote:cloud:ses_9")).toBe("cloud:ses_9")
  expect(remoteThreadKeyFromRouteId(decodeURIComponent(workspaceSessionRoute("ws_1", id).split("/").at(-1) ?? ""))).toBe("command:rsc_01abc")
  for (const local of ["ses_123", "remote:", "remote:other:x", "remote:command:a/b", "remote:command:", null, undefined]) {
    expect(remoteThreadKeyFromRouteId(local)).toBeNull()
    expect(isRemoteSessionRouteId(local)).toBe(false)
  }
})

test("Esc from a task returns to its chat at the same pane, scroll and row, with the task's draft flushed", () => {
  const scope = JSON.stringify(["http://engine", "ws_1", "draft-scope"])
  const child = remoteSessionRouteId("command:rsc_esc")
  rememberChildOrigin(scope, child, { parentId: "ses_parent", pane: "primary", anchor: "command:rsc_esc", scrollTop: 640, brief: "Check the notes", title: "Release" })
  let flushed = 0
  const unregister = registerChildDraftPersistence(scope, child, () => { flushed += 1 })
  const origin = prepareChildReturn(scope, child)
  expect(origin?.parentId).toBe("ses_parent")
  expect(flushed).toBe(1)
  // The other pane never restores this return; the chat's own pane does, once.
  expect(consumeChildReturn(scope, "ses_parent", "secondary")).toBeUndefined()
  expect(consumeChildReturn(scope, "ses_parent", "primary")).toMatchObject({ anchor: "command:rsc_esc", scrollTop: 640 })
  expect(consumeChildReturn(scope, "ses_parent", "primary")).toBeUndefined()
  unregister()
})

test("a stored task origin is read back only when it is complete", () => {
  const origin = {
    start: { key: "command:rsc_1", ref: { commandId: "rsc_1" }, toolCallId: "call_1", title: "Check the notes", prompt: null,
      target: "desktop", sessionId: "ses_remote", workspaceId: null, computerId: "cmp_1" },
    owner: { workspaceId: "ws_1", sessionId: "ses_parent" },
    parentTitle: "Release",
  }
  expect(parseRemoteHelperOrigin(JSON.parse(JSON.stringify(origin)))).toEqual(origin)
  expect(parseRemoteHelperOrigin({ ...origin, owner: { workspaceId: "ws_1" } })).toBeNull()
  expect(parseRemoteHelperOrigin({ ...origin, start: { ...origin.start, target: "elsewhere" } })).toBeNull()
  expect(parseRemoteHelperOrigin("nope")).toBeNull()
  rememberRemoteHelperOrigin(origin, "cloud:member:org")
  expect(remoteHelperOrigin(origin.start.key, "cloud:member:org")).toEqual(origin)
  expect(remoteHelperOrigin(origin.start.key, "cloud:another:org")).toBeNull()
  expect(remoteHelperOrigin(origin.start.key, null)).toBeNull()
})

test("opening a remote task beside its parent keeps it in the native workbench split pane across syncs", () => {
  const parent = { workspaceId: "ws_1", sessionId: "ses_parent", title: "Parent chat" }
  const remote = { workspaceId: "ws_1", sessionId: remoteSessionRouteId("command:rsc_split"), title: "Remote task" }
  let state: WorkbenchSnapshot = { revision: 0, primary: null, tabs: [], secondary: null, focusedPane: "primary", sideChats: {} }
  state = openWorkbenchTab(state, parent)
  state = openWorkbenchTab(state, remote)
  state = setWorkbenchSideChat(state, parent, remote)
  state = syncWorkbenchSnapshot(state, {
    workspaceId: "ws_1",
    workspaceTitle: "openwork-repo",
    primarySessionId: "ses_parent",
    sessions: [parent],
    sessionsKnown: true,
  })
  expect(state.primary?.sessionId).toBe("ses_parent")
  expect(state.secondary?.sessionId).toBe("remote:command:rsc_split")
  expect(state.secondary?.title).toBe("Remote task")
})
