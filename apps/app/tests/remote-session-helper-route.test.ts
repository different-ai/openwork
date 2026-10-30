import { expect, test } from "bun:test"
import { consumeChildReturn, prepareChildReturn, registerChildDraftPersistence, rememberChildOrigin } from "../src/lib/child-navigation"
import { isRemoteSessionRouteId, remoteSessionRouteId, remoteThreadKeyFromRouteId } from "../src/lib/remote-session-route"
import {
  parseRemoteHelperOrigin,
  remoteHelperDraft,
  saveRemoteHelperDraft,
} from "../src/react-app/domains/session/remote-threads/remote-helper-navigation"
import { workspaceSessionRoute } from "../src/react-app/shell/workspace-routes"

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

test("the task's follow-up draft survives leaving and coming back", () => {
  saveRemoteHelperDraft("command:rsc_draft", "also check the changelog")
  expect(remoteHelperDraft("command:rsc_draft")).toBe("also check the changelog")
  saveRemoteHelperDraft("command:rsc_draft", "")
  expect(remoteHelperDraft("command:rsc_draft")).toBe("")
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
})
