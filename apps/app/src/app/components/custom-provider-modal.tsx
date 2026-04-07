import { CheckCircle2, Plus, Trash2, X, AlertTriangle } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { t, currentLocale } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";
import {
  type CustomProviderConfig,
  type ProviderPresetKey,
  validateProviderId,
  validateBaseUrl,
  PROVIDER_PRESETS,
} from "../provider-config";

const translate = (key: string) => t(key, currentLocale());

type ModelEntry = {
  id: string;
  name: string;
};

export type CustomProviderModalProps = {
  open: boolean;
  projectDir: string;
  existingProviderIds: string[];
  onSubmit: (providerId: string, config: CustomProviderConfig) => Promise<void>;
  onClose: () => void;
};

type ViewStep = "form" | "submitting" | "success" | "error";

const NPM_OPTIONS = [
  { value: "@ai-sdk/openai-compatible", label: "OpenAI Compatible" },
  { value: "@ai-sdk/ollama", label: "Ollama" },
];

export default function CustomProviderModal(props: CustomProviderModalProps) {
  const [view, setView] = createSignal<ViewStep>("form");
  const [error, setError] = createSignal<string | null>(null);

  // Form fields
  const [providerId, setProviderId] = createSignal("");
  const [providerName, setProviderName] = createSignal("");
  const [selectedPreset, setSelectedPreset] = createSignal<ProviderPresetKey | "custom">("openaiCompatible");
  const [npmPackage, setNpmPackage] = createSignal("@ai-sdk/openai-compatible");
  const [baseUrl, setBaseUrl] = createSignal("");
  const [models, setModels] = createSignal<ModelEntry[]>([{ id: "", name: "" }]);
  const [apiKey, setApiKey] = createSignal("");

  // Validation
  const providerIdError = createMemo(() => {
    const id = providerId().trim();
    if (!id) return null;
    try {
      validateProviderId(id);
      if (props.existingProviderIds.includes(id.toLowerCase())) {
        return "Provider ID already exists";
      }
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid provider ID";
    }
  });

  const baseUrlError = createMemo(() => {
    const url = baseUrl().trim();
    if (!url) return null;
    try {
      validateBaseUrl(url);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid URL";
    }
  });

  const hasValidModel = createMemo(() => {
    return models().some((m) => m.id.trim() && m.name.trim());
  });

  const canSubmit = createMemo(() => {
    return (
      providerId().trim() &&
      !providerIdError() &&
      providerName().trim() &&
      baseUrl().trim() &&
      !baseUrlError() &&
      hasValidModel() &&
      view() === "form"
    );
  });

  // Reset form when modal opens
  createEffect(() => {
    if (props.open) {
      setView("form");
      setError(null);
      setProviderId("");
      setProviderName("");
      setSelectedPreset("openaiCompatible");
      setNpmPackage("@ai-sdk/openai-compatible");
      setBaseUrl("");
      setModels([{ id: "", name: "" }]);
      setApiKey("");
    }
  });

  // Update form when preset changes
  createEffect(() => {
    const preset = selectedPreset();
    if (preset === "custom") return;

    const presetConfig = PROVIDER_PRESETS[preset];
    setProviderName(presetConfig.name);
    setNpmPackage(presetConfig.npm);
    setBaseUrl(presetConfig.defaultBaseURL);
  });

  const addModel = () => {
    setModels([...models(), { id: "", name: "" }]);
  };

  const removeModel = (index: number) => {
    const current = models();
    if (current.length > 1) {
      setModels([...current.slice(0, index), ...current.slice(index + 1)]);
    }
  };

  const updateModel = (index: number, field: "id" | "name", value: string) => {
    const current = models();
    current[index] = { ...current[index], [field]: value };
    setModels([...current]);
  };

  const handleSubmit = async () => {
    if (!canSubmit()) return;

    setView("submitting");
    setError(null);

    try {
      const validatedId = validateProviderId(providerId());
      const validatedUrl = validateBaseUrl(baseUrl());

      // Build model config
      const modelConfig: CustomProviderConfig["models"] = {};
      for (const model of models()) {
        const trimmedId = model.id.trim();
        const trimmedName = model.name.trim();
        if (trimmedId && trimmedName) {
          modelConfig[trimmedId] = { name: trimmedName };
        }
      }

      const config: CustomProviderConfig = {
        npm: npmPackage(),
        name: providerName().trim(),
        options: {
          baseURL: validatedUrl,
          ...(apiKey().trim() ? { apiKey: apiKey().trim() } : {}),
        },
        models: modelConfig,
      };

      await props.onSubmit(validatedId, config);
      setView("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add provider");
      setView("error");
    }
  };

  const handleClose = () => {
    props.onClose();
  };

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden max-h-[calc(100vh-2rem)] flex flex-col">
          {/* Header */}
          <div class="px-6 pt-6 pb-4 border-b border-gray-6/50 flex items-start justify-between gap-4">
            <div>
              <h3 class="text-lg font-semibold text-gray-12">Add custom provider</h3>
              <p class="text-sm text-gray-11 mt-1">Configure your own model API provider.</p>
            </div>
            <Button variant="ghost" class="!p-2 rounded-full" onClick={handleClose}>
              <X size={16} />
            </Button>
          </div>

          {/* Content */}
          <div class="px-6 py-4 flex flex-col gap-4 min-h-0 overflow-y-auto">
            {/* Error message */}
            <Show when={error()}>
              <div class="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
                {error()}
              </div>
            </Show>

            {/* Success message */}
            <Show when={view() === "success"}>
              <div class="rounded-xl border border-green-7/30 bg-green-1/40 px-4 py-3 flex items-center gap-2">
                <CheckCircle2 size={16} class="text-green-11" />
                <span class="text-sm text-green-12">Provider added successfully!</span>
              </div>
              <div class="text-xs text-gray-10">
                The provider has been added to your configuration. You may need to reload the workspace for changes to take effect.
              </div>
            </Show>

            {/* Form */}
            <Show when={view() === "form" || view() === "submitting"}>
              {/* Preset selector */}
              <div class="space-y-2">
                <label class="text-xs font-medium text-gray-11">Preset</label>
                <div class="flex flex-wrap gap-2">
                  <For each={Object.entries(PROVIDER_PRESETS)}>
                    {([key, preset]) => (
                      <button
                        type="button"
                        class={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                          selectedPreset() === key
                            ? "border-dls-accent bg-dls-accent/10 text-dls-accent"
                            : "border-gray-6 bg-gray-1 text-gray-11 hover:bg-gray-3"
                        }`}
                        onClick={() => setSelectedPreset(key as ProviderPresetKey)}
                      >
                        {preset.name}
                      </button>
                    )}
                  </For>
                  <button
                    type="button"
                    class={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                      selectedPreset() === "custom"
                        ? "border-dls-accent bg-dls-accent/10 text-dls-accent"
                        : "border-gray-6 bg-gray-1 text-gray-11 hover:bg-gray-3"
                    }`}
                    onClick={() => setSelectedPreset("custom")}
                  >
                    Custom
                  </button>
                </div>
              </div>

              {/* Provider ID */}
              <div class="space-y-1">
                <TextInput
                  label="Provider ID"
                  type="text"
                  placeholder="my-custom-provider"
                  value={providerId()}
                  onInput={(e) => setProviderId(e.currentTarget.value)}
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck={false}
                  disabled={view() === "submitting"}
                />
                <Show when={providerIdError()}>
                  <div class="text-xs text-red-11">{providerIdError()}</div>
                </Show>
                <div class="text-[11px] text-gray-9">
                  Unique identifier (alphanumeric, -, _)
                </div>
              </div>

              {/* Provider Name */}
              <TextInput
                label="Display name"
                type="text"
                placeholder="My Custom Provider"
                value={providerName()}
                onInput={(e) => setProviderName(e.currentTarget.value)}
                autocomplete="off"
                disabled={view() === "submitting"}
              />

              {/* NPM Package */}
              <div class="space-y-2">
                <label class="text-xs font-medium text-gray-11">SDK Package</label>
                <select
                  class="w-full bg-dls-surface border border-dls-border rounded-xl py-2.5 px-3 text-sm text-dls-text focus:outline-none focus:ring-1 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] focus:border-dls-accent"
                  value={npmPackage()}
                  onChange={(e) => setNpmPackage(e.currentTarget.value)}
                  disabled={view() === "submitting"}
                >
                  <For each={NPM_OPTIONS}>
                    {(opt) => <option value={opt.value}>{opt.label}</option>}
                  </For>
                </select>
              </div>

              {/* Base URL */}
              <div class="space-y-1">
                <TextInput
                  label="Base URL"
                  type="text"
                  placeholder="https://api.example.com/v1"
                  value={baseUrl()}
                  onInput={(e) => setBaseUrl(e.currentTarget.value)}
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck={false}
                  disabled={view() === "submitting"}
                />
                <Show when={baseUrlError()}>
                  <div class="text-xs text-red-11">{baseUrlError()}</div>
                </Show>
                <div class="text-[11px] text-gray-9">
                  The API endpoint URL (e.g., http://localhost:11434 for Ollama)
                </div>
              </div>

              {/* Models */}
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <label class="text-xs font-medium text-gray-11">Models</label>
                  <Button
                    variant="ghost"
                    class="!p-1 !text-xs"
                    onClick={addModel}
                    disabled={view() === "submitting"}
                  >
                    <Plus size={14} class="mr-1" /> Add model
                  </Button>
                </div>
                <For each={models()}>
                  {(model, index) => (
                    <div class="flex items-start gap-2">
                      <div class="flex-1 space-y-2">
                        <input
                          type="text"
                          placeholder="model-id"
                          value={model.id}
                          onInput={(e) => updateModel(index(), "id", e.currentTarget.value)}
                          class="w-full bg-dls-surface border border-dls-border rounded-lg py-2 px-3 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-1 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] focus:border-dls-accent"
                          disabled={view() === "submitting"}
                        />
                        <input
                          type="text"
                          placeholder="Display name"
                          value={model.name}
                          onInput={(e) => updateModel(index(), "name", e.currentTarget.value)}
                          class="w-full bg-dls-surface border border-dls-border rounded-lg py-2 px-3 text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-1 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] focus:border-dls-accent"
                          disabled={view() === "submitting"}
                        />
                      </div>
                      <Show when={models().length > 1}>
                        <Button
                          variant="ghost"
                          class="!p-2 text-gray-10 hover:text-red-11"
                          onClick={() => removeModel(index())}
                          disabled={view() === "submitting"}
                        >
                          <Trash2 size={16} />
                        </Button>
                      </Show>
                    </div>
                  )}
                </For>
                <Show when={!hasValidModel()}>
                  <div class="text-xs text-amber-11">At least one model with ID and name is required</div>
                </Show>
              </div>

              {/* API Key (optional) */}
              <div class="space-y-2">
                <TextInput
                  label="API Key (optional)"
                  type="password"
                  placeholder="sk-..."
                  value={apiKey()}
                  onInput={(e) => setApiKey(e.currentTarget.value)}
                  autocomplete="off"
                  disabled={view() === "submitting"}
                />
                <div class="flex items-start gap-2 text-[11px] text-amber-11 bg-amber-1/40 border border-amber-7/30 rounded-lg px-3 py-2">
                  <AlertTriangle size={14} class="shrink-0 mt-0.5" />
                  <span>API keys are stored in plaintext in opencode.json. Consider using environment variables instead.</span>
                </div>
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class="px-6 pt-4 pb-6 border-t border-gray-6/50 flex flex-col gap-3">
            <div class="flex items-center justify-end gap-3">
              <Show when={view() === "success"}>
                <Button variant="outline" onClick={handleClose}>
                  Close
                </Button>
              </Show>
              <Show when={view() === "form" || view() === "submitting" || view() === "error"}>
                <Button variant="outline" onClick={handleClose} disabled={view() === "submitting"}>
                  Cancel
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleSubmit}
                  disabled={!canSubmit()}
                >
                  {view() === "submitting" ? "Adding..." : "Add provider"}
                </Button>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
