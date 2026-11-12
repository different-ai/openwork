import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomProviderModelList, ModelSettingsForm, type ModelListProps } from "./custom-provider-model-list";
import { EMPTY_MODEL_SETTINGS, type ModelDraft } from "./custom-provider-models";

const noop = () => undefined;
const matched: ModelDraft = {
  key: "a", origin: { kind: "matched", match: { providerId: "openrouter", modelId: "openai/gpt-4o", by: "suffix" } }, selected: true, configured: true, missing: false,
  settings: { ...EMPTY_MODEL_SETTINGS, id: "gpt-4o", name: "GPT-4o", context: "128000", outputLimit: "16384" },
};
const unknown: ModelDraft = { key: "b", origin: { kind: "unknown" }, selected: false, configured: false, missing: true, settings: { ...EMPTY_MODEL_SETTINGS, id: "acme-secret" } };

function render(patch: Partial<ModelListProps> = {}) {
  return renderToStaticMarkup(
    <CustomProviderModelList drafts={[matched, unknown]} expandedKey={null} highlight={null} templates={{ templates: [], busy: false, error: null, retry: noop }}
      onToggle={noop} onSetAll={noop} onUpdate={noop} onApplyTemplate={noop} onSetUpManually={noop} onAddTemplate={noop} onAddCustom={noop} onRemove={noop} onExpand={noop} {...patch} />,
  );
}

test("the list shows matched, unconfigured and no-longer-listed models", () => {
  const html = render();
  assert.match(html, /data-model-id="gpt-4o"[^>]*data-selected="true"/);
  assert.match(html, /data-testid="custom-model-matched"/);
  assert.match(html, /data-testid="custom-model-needs-settings"/);
  assert.match(html, /data-testid="custom-model-missing"/);
  assert.match(html, /data-testid="custom-model-manual"/);
  assert.match(html, /1 of 2 selected/);
  assert.doesNotMatch(html, /custom-model-settings/, "settings stay closed until opened");
});

test("an open, highlighted model shows its settings and the reason", () => {
  const html = render({ expandedKey: "a", highlight: { key: "a", field: "context", message: "Enter the context window." } });
  assert.match(html, /data-testid="custom-model-settings"/);
  assert.match(html, /data-testid="custom-model-error"[^>]*>Enter the context window\./);
  assert.match(html, /data-testid="custom-model-field-context"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*data-testid="custom-model-field-context"/);
  assert.match(html, /Settings from openai\/gpt-4o/);
});

test("reasoning options appear only while reasoning is on", () => {
  const off = renderToStaticMarkup(<ModelSettingsForm settings={EMPTY_MODEL_SETTINGS} onChange={noop} invalidField={null} />);
  assert.doesNotMatch(off, /custom-model-reasoning-toggle/);
  const on = renderToStaticMarkup(<ModelSettingsForm settings={{ ...EMPTY_MODEL_SETTINGS, reasoning: true }} onChange={noop} invalidField={null} />);
  assert.match(on, /custom-model-reasoning-toggle/);
  assert.match(on, /custom-model-field-reasoningEfforts/);
});
