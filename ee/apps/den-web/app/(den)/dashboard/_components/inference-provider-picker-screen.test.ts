import assert from "node:assert/strict";
import test from "node:test";
import { initialProviders, orderCatalog } from "./inference-provider-picker-screen";

const ids = ["openrouter", "anthropic", "openai", "google", "google-vertex", "google-vertex-anthropic", "azure", "amazon-bedrock", "microsoft-foundry", "litellm", "truefoundry", "mistral", "groq", "zzz"];
const catalog = orderCatalog(ids.map((id) => ({ id, name: id })));

test("LiteLLM and TrueFoundry show in the first rows, never behind Show more", () => {
  const visible = initialProviders(catalog).map((item) => item.id);
  assert.equal(visible.length, 11);
  assert.ok(visible.includes("litellm"));
  assert.ok(visible.includes("truefoundry"));
  assert.ok(!visible.includes("mistral"));
  assert.deepEqual(visible.slice(-2), ["litellm", "truefoundry"], "they keep their place in the list");
});

test("without TrueFoundry the list is the usual first rows", () => {
  const visible = initialProviders(catalog.filter((item) => item.id !== "truefoundry")).map((item) => item.id);
  assert.equal(visible.length, 10);
  assert.equal(visible.at(-1), "litellm");
});
