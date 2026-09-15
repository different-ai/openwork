/** Typed display-catalog fixtures, independent of either engine's SDK. */
import type { connectedModelCatalog } from "./threads.ts";

type Catalog = Parameters<typeof connectedModelCatalog>[0];
type CatalogProvider = Catalog["all"][number];
type Model = CatalogProvider["models"][string] & {
  id: string; providerID: string; name: string; status: string; release_date: string;
  api: { id: string; url: string; npm: string };
  capabilities: {
    temperature: boolean; reasoning: boolean; attachment: boolean; toolcall: boolean; interleaved: false;
    input: Record<string, boolean>; output: Record<string, boolean>;
  };
  cost: { input: number; output: number; cache: { read: number; write: number } };
  limit: { context: number; input?: number; output: number };
  options: Record<string, unknown>; headers: Record<string, string>;
};
type Provider = CatalogProvider & { models: Record<string, Model>; source: string; env: string[]; options: Record<string, unknown> };
type ProviderListResponse = Omit<Catalog, "all"> & { all: Provider[] };

type ModelSketch = {
  name: string;
  family?: string;
  status?: Model["status"];
  release_date?: string;
  capabilities?: { toolcall?: boolean; reasoning?: boolean; attachment?: boolean; temperature?: boolean };
  variants?: Model["variants"];
};

export function fixtureModel(providerID: string, id: string, sketch: ModelSketch): Model {
  return {
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
    ...(sketch.family !== undefined ? { family: sketch.family } : {}),
    ...(sketch.variants !== undefined ? { variants: sketch.variants } : {}),
  };
}

export function fixtureProvider(input: {
  id: string;
  name: string;
  source?: Provider["source"];
  env?: string[];
  options?: Provider["options"];
  models: Record<string, ModelSketch>;
}): Provider {
  const models: Record<string, Model> = {};
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
