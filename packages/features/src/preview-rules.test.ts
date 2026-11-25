import assert from "node:assert/strict"
import { test } from "node:test"
import { FEATURE_KEYS, FEATURES, RETIRED_FEATURE_KEYS } from "@openwork/features"
import { EXPIRY_WARNING_DAYS, MAX_PREVIEW_DAYS, firstUnsortedKey, previewRuleProblems } from "@openwork/features/preview-rules"

const today = "2026-11-24"
const preview = {
  label: "Sample preview",
  description: "What a person gets.",
  category: "experience",
  added: "2026-11-01",
  owner: "sample-owner",
  expiresOn: "2026-12-31",
  deployments: ["cloud", "self_hosted"],
  default: false,
}

function day(offset: number): string {
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
}

test("a preview with an owner and a coming expiry date passes", () => {
  assert.deepEqual(previewRuleProblems("samplePreview", preview, today), { problems: [], warnings: [] })
})

test("every preview needs an owner", () => {
  for (const owner of [undefined, "", "two words", "@handle"]) {
    const { problems } = previewRuleProblems("samplePreview", { ...preview, owner }, today)
    assert.equal(problems.length, 1, String(owner))
    assert.match(problems[0] ?? "", /needs an owner/)
  }
  const { problems } = previewRuleProblems("samplePreview", { ...preview, owner: undefined, author: "sample-owner" }, today)
  assert.match(problems.join("\n"), /needs an owner/, "the old author field does not count")
})

test("every preview needs an expiry date that is a real day after the day it was added", () => {
  for (const expiresOn of [undefined, "", "2026-12", "2026-02-30", "soon"]) {
    const { problems } = previewRuleProblems("samplePreview", { ...preview, expiresOn }, today)
    assert.equal(problems.length, 1, String(expiresOn))
    assert.match(problems[0] ?? "", /needs expiresOn/)
  }
  assert.match(previewRuleProblems("samplePreview", { ...preview, added: "2026-11-24", expiresOn: "2026-11-24" }, today).problems.join("\n"), /must be after the day it was added/)
})

test("an expired preview fails and names its owner; the expiry day itself still passes", () => {
  const expired = previewRuleProblems("samplePreview", { ...preview, expiresOn: day(-1) }, today)
  assert.equal(expired.problems.length, 1)
  assert.match(expired.problems[0] ?? "", /expired on 2026-11-23 \(owner @sample-owner\)\. Ship it .* cut it, or set a new expiresOn/)
  const lastDay = previewRuleProblems("samplePreview", { ...preview, expiresOn: today }, today)
  assert.deepEqual(lastDay.problems, [])
  assert.match(lastDay.warnings[0] ?? "", /expires on 2026-11-24 \(owner @sample-owner\): today to ship or cut it/)
})

test("an expiry date cannot be parked far in the future", () => {
  assert.deepEqual(previewRuleProblems("samplePreview", { ...preview, expiresOn: day(MAX_PREVIEW_DAYS) }, today).problems, [])
  assert.match(previewRuleProblems("samplePreview", { ...preview, expiresOn: day(MAX_PREVIEW_DAYS + 1) }, today).problems.join("\n"), /more than 183 days away/)
})

test("a preview close to its expiry warns without failing", () => {
  const close = previewRuleProblems("samplePreview", { ...preview, expiresOn: day(EXPIRY_WARNING_DAYS) }, today)
  assert.deepEqual(close.problems, [])
  assert.match(close.warnings[0] ?? "", /14 days left/)
  assert.deepEqual(previewRuleProblems("samplePreview", { ...preview, expiresOn: day(EXPIRY_WARNING_DAYS + 1) }, today).warnings, [])
})

test("keys, labels, categories and deployments are still checked", () => {
  assert.match(previewRuleProblems("SamplePreview", preview, today).problems.join("\n"), /must be lowerCamelCase/)
  assert.match(previewRuleProblems("sampleHTTPPreview", preview, today).problems.join("\n"), /must be lowerCamelCase/)
  assert.match(previewRuleProblems("samplePreview", { ...preview, label: " " }, today).problems.join("\n"), /needs a label and a description/)
  assert.match(previewRuleProblems("samplePreview", { ...preview, category: "misc" }, today).problems.join("\n"), /needs a category/)
  assert.match(previewRuleProblems("samplePreview", { ...preview, deployments: [] }, today).problems.join("\n"), /at least one deployment/)
  assert.match(previewRuleProblems("samplePreview", { ...preview, added: "last week" }, today).problems.join("\n"), /added must be the day/)
})

test("exports are kept in alphabetical order", () => {
  assert.equal(firstUnsortedKey(["alpha", "beta", "betaTwo", "gamma"]), null)
  assert.deepEqual(firstUnsortedKey(["alpha", "gamma", "beta"]), { key: "beta", after: "gamma" })
  assert.equal(firstUnsortedKey([...FEATURE_KEYS]), null)
})

test("every preview in the registry has an owner and an expiry date, and none is also retired", () => {
  const retired = new Set<string>(RETIRED_FEATURE_KEYS)
  for (const key of FEATURE_KEYS) {
    assert.match(FEATURES[key].owner, /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, key)
    assert.match(FEATURES[key].expiresOn, /^\d{4}-\d{2}-\d{2}$/, key)
    assert.ok(FEATURES[key].expiresOn > FEATURES[key].added, key)
    assert.equal(retired.has(key), false, key)
  }
  assert.equal(retired.size, RETIRED_FEATURE_KEYS.length, "a key is retired once")
})
