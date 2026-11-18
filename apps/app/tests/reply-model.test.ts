import { expect, test } from "bun:test"
import type { UIMessage } from "ai"
import { replyModelLabel, replyModelProvider } from "../src/react-app/domains/session/sync/reply-model"
import { AUTO_MODEL_ID } from "../src/react-app/domains/models/model-catalog"

function reply(model: object): UIMessage {
  return { id: "reply", role: "assistant", parts: [], metadata: { opencode: { replyModel: model } } }
}

test("Auto keeps the OpenWork mark and reports the routed name once", () => {
  const message = reply({ requestedProviderID: "openwork", requestedModelID: AUTO_MODEL_ID,
    providerID: "openai", modelID: "gpt-6", name: "GPT-6", resolved: true })
  expect(replyModelLabel(message)).toBe("GPT-6")
  expect(replyModelProvider(message)).toBe("openwork")
})

test("direct provider replies use their provider mark", () => {
  const message = reply({ providerID: "anthropic", modelID: "claude-sonnet", name: "Claude Sonnet", resolved: true })
  expect(replyModelLabel(message)).toBe("Claude Sonnet")
  expect(replyModelProvider(message)).toBe("anthropic")
})

test("opaque gateway ids are neither labels nor provider monograms", () => {
  const message = reply({ providerID: "ipr_fixture", modelID: "gwm_fixture", resolved: true })
  expect(replyModelLabel(message)).toBeNull()
  expect(replyModelProvider(message)).toBeUndefined()
})

test("gateway requested identities fall back only to a catalog title", () => {
  const message = reply({ providerID: "ipr_fixture", modelID: "gwm_fixture" })
  const resolve = (model: { providerID: string; modelID: string }) =>
    model.providerID === "ipr_fixture" && model.modelID === "gwm_fixture" ? "GPT-6 Luna" : undefined
  expect(replyModelLabel(message, resolve)).toBe("GPT-6 Luna")
  expect(replyModelLabel(reply({ providerID: "ipr_fixture", modelID: "gwm_fixture", resolved: true }), resolve)).toBe("GPT-6 Luna")
  expect(replyModelLabel(message, () => "gwm_fixture")).toBeNull()
  expect(replyModelLabel(message, () => "ipr_fixture")).toBeNull()
  expect(replyModelProvider(message)).toBeUndefined()
})

test("resolved identity wins over the requested catalog title", () => {
  expect(replyModelLabel(reply({ providerID: "openai", modelID: "gpt-6", name: "GPT-6", resolved: true }), () => "Other model")).toBe("GPT-6")
  expect(replyModelLabel(reply({ providerID: "openwork", modelID: AUTO_MODEL_ID, resolved: true }))).toBe("GPT-6 Luna")
  expect(replyModelLabel(reply({ providerID: "openwork", modelID: AUTO_MODEL_ID }), () => "OpenWork Free")).toBeNull()
})

test("an opaque resolved name never leaks even without a gateway provider", () => {
  expect(replyModelLabel(reply({ modelID: "gwm_fixture", name: "ipr_fixture", resolved: true }))).toBeNull()
})

test("unresolved and missing metadata stay absent without a catalog match", () => {
  expect(replyModelLabel(reply({ providerID: "openai", modelID: "gpt-6" }))).toBeNull()
  expect(replyModelLabel(reply({}))).toBeNull()
})

const SMART = "openwork-smart-ar_engineering"
const smartTitle = (model: { providerID: string; modelID: string }) =>
  model.providerID === "openwork-auto" && model.modelID === SMART ? "Smart: Engineering" : undefined

function autoReply(times: { created?: number; completed?: number }): UIMessage {
  return { id: "auto", role: "assistant", parts: [], metadata: { opencode: { ...times,
    replyModel: { providerID: "openwork-auto", modelID: SMART, requestedProviderID: "openwork-auto", requestedModelID: SMART } } } }
}
const haiku = { at: 1_500, provider: "anthropic", model: "claude-haiku-5-5", name: "Claude Haiku 5.5", thinking: "high" }

test("a Smart reply names the model the gateway routed it to", () => {
  const message = autoReply({ created: 1_000, completed: 4_000 })
  expect(replyModelLabel(message, smartTitle, [haiku])).toBe("Claude Haiku 5.5 · High")
  expect(replyModelProvider(message, [haiku])).toBe("anthropic")
  expect(replyModelLabel(message, smartTitle, [{ ...haiku, thinking: "default" }])).toBe("Claude Haiku 5.5")
})

test("each Smart reply takes the decision made while it ran, the latest on retry", () => {
  const routes = [
    { ...haiku, at: 500, name: "Claude Opus 5", thinking: "max" },
    { ...haiku, at: 1_200, name: "Claude Sonnet 5" },
    { ...haiku, at: 1_800 },
    { ...haiku, at: 9_000, name: "Claude Opus 5" },
  ]
  expect(replyModelLabel(autoReply({ created: 1_000, completed: 4_000 }), undefined, routes)).toBe("Claude Haiku 5.5 · High")
  expect(replyModelLabel(autoReply({ created: 8_000, completed: 9_500 }), undefined, routes)).toBe("Claude Opus 5 · High")
  // The response headers may arrive just before the engine stamps the reply.
  expect(replyModelLabel(autoReply({ created: 3_000, completed: 4_000 }), undefined, [{ ...haiku, at: 2_500 }])).toBe("Claude Haiku 5.5 · High")
})

test("a Smart reply without a decision keeps its router's name", () => {
  expect(replyModelLabel(autoReply({ created: 1_000, completed: 4_000 }), smartTitle, [{ ...haiku, at: 20_000 }])).toBe("Smart: Engineering")
  expect(replyModelLabel(autoReply({ created: 1_000, completed: 4_000 }), smartTitle)).toBe("Smart: Engineering")
  expect(replyModelLabel(autoReply({ completed: 4_000 }), smartTitle, [haiku])).toBe("Smart: Engineering")
  expect(replyModelProvider(autoReply({ created: 1_000, completed: 4_000 }))).toBe("openwork-auto")
})

test("a Smart reply never shows its model id, even when the engine reports it as resolved", () => {
  const resolved: UIMessage = { id: "auto", role: "assistant", parts: [], metadata: { opencode: { created: 1_000, completed: 4_000,
    replyModel: { providerID: "openwork-auto", modelID: SMART, name: SMART, resolved: true, requestedProviderID: "openwork-auto", requestedModelID: SMART } } } }
  expect(replyModelLabel(resolved, smartTitle)).toBe("Smart: Engineering")
  expect(replyModelLabel(resolved)).toBe("Smart")
  expect(replyModelLabel(autoReply({ created: 1_000, completed: 4_000 }), () => SMART.replace("openwork-smart-", "ipr_"))).toBe("Smart")
})

test("a routed model without a name uses the catalog name, then a public id, never an opaque one", () => {
  const unnamed = { at: 1_500, provider: "anthropic", model: "anthropic/claude-haiku-5-5", thinking: "low" }
  const message = autoReply({ created: 1_000, completed: 4_000 })
  expect(replyModelLabel(message, undefined, [unnamed], id => id === "anthropic/claude-haiku-5-5" ? "Claude Haiku 5.5" : undefined)).toBe("Claude Haiku 5.5 · Low")
  expect(replyModelLabel(message, undefined, [unnamed])).toBe("claude-haiku-5-5 · Low")
  expect(replyModelLabel(message, smartTitle, [{ ...unnamed, model: "gwm_fixture", name: "ipr_fixture" }])).toBe("Smart: Engineering")
  expect(replyModelProvider(message, [{ ...unnamed, provider: "ipr_fixture" }])).toBeUndefined()
})

test("routing decisions never relabel other models' replies", () => {
  const message = reply({ providerID: "anthropic", modelID: "claude-sonnet", name: "Claude Sonnet", resolved: true })
  expect(replyModelLabel(message, undefined, [haiku])).toBe("Claude Sonnet")
  expect(replyModelLabel(reply({ requestedProviderID: "openwork", requestedModelID: AUTO_MODEL_ID, providerID: "openai", modelID: "gpt-6", name: "GPT-6", resolved: true }), undefined, [haiku])).toBe("GPT-6")
})
