import { afterEach, expect, test } from "bun:test"
import { AUTO_ROUTES_EVENT, createV2EventTranslationState, translateV2Event } from "../src/app/lib/opencode-v2-adapter"
import { autoRoutesFromSession, useAutoRouteStore } from "../src/react-app/domains/session/sync/auto-route-store"

const haiku = { at: 1_500, provider: "anthropic", model: "claude-haiku-5-5", name: "Claude Haiku 5.5", thinking: "high" }

afterEach(() => useAutoRouteStore.setState({ bySession: {} }))

test("the engine's session metadata update becomes the app's Smart routes event", () => {
  const events = translateV2Event({
    type: "session.metadata.updated",
    durable: { aggregateID: "ses_auto", seq: 4, version: 1 },
    data: { sessionID: "ses_auto", metadata: { other: true, openworkAutoRoutes: [haiku, { at: "bad" }] } },
  }, createV2EventTranslationState())
  expect(events).toEqual([{ type: AUTO_ROUTES_EVENT, properties: { sessionID: "ses_auto", routes: [haiku] } }])
})

test("snapshot and live routes merge in time order without duplicates", () => {
  const later = { ...haiku, at: 3_000, name: "Claude Opus 5" }
  const store = useAutoRouteStore.getState()
  store.publish("ses_auto", [later])
  store.publish("ses_auto", [haiku, later])
  store.publish("ses_auto", [])
  expect(useAutoRouteStore.getState().bySession.ses_auto).toEqual([haiku, later])
})

test("a mapped native session carries its recorded routes", () => {
  expect(autoRoutesFromSession({ id: "ses_auto", openworkAutoRoutes: [haiku] })).toEqual([haiku])
  expect(autoRoutesFromSession({ id: "ses_auto" })).toEqual([])
  expect(autoRoutesFromSession(null)).toEqual([])
})
