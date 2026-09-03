/**
 * Typed builders for the engine's provider catalog, for tests. They fill every
 * field the SDK type requires so a test can state only what it cares about
 * (a model's name, its capabilities) without casting.
 */
import type { Model, Provider, ProviderListResponse } from "@opencode-ai/sdk/v2/client";

type ModelSketch = {
  name: string;
  family?: string;
  status?: Model["status"];
  release_date?: string;
  capabilities?: Partial<Pick<Model["capabilities"], "toolcall" | "reasoning" | "attachment" | "temperature">>;
  variants?: Model["variants"];
};

export function fixtureModel(providerID: string, id: string, sketch: ModelSketch): Model {
  const model: Model = {
    id,
    providerID,
    api: { id, url: "", npm: "" },
    name: sketch.name,
    capabilities: {
      temperature: sketch.capabilities?.temperature ?? true,
      reasoning: sketch.capabilities?.reasoning ?? false,
      attachment: sketch.capabilities?.attachment ?? false,
      toolcall: sketch.capabilities?.toolcall ?? true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 8_192 },
    status: sketch.status ?? "active",
    options: {},
    headers: {},
    release_date: sketch.release_date ?? "2026-01-01",
  };
  if (sketch.family !== undefined) model.family = sketch.family;
  if (sketch.variants !== undefined) model.variants = sketch.variants;
  return model;
}

export function fixtureProvider(input: {
  id: string;
  name: string;
  source?: Provider["source"];
  env?: string[];
  options?: Provider["options"];
  models: Record<string, ModelSketch>;
}): Provider {
  const models: Provider["models"] = {};
  for (const [modelId, sketch] of Object.entries(input.models)) models[modelId] = fixtureModel(input.id, modelId, sketch);
  return {
    id: input.id,
    name: input.name,
    source: input.source ?? "config",
    env: input.env ?? [],
    options: input.options ?? {},
    models,
  };
}

export function fixtureCatalog(input: { all: Provider[]; connected?: string[]; default?: Record<string, string> }): ProviderListResponse {
  return { all: input.all, connected: input.connected ?? [], default: input.default ?? {} };
}
