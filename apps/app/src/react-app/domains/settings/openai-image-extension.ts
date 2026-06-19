export type LocalProviderInstallInput = {
  providerId: string;
  name: string;
  baseURL: string;
  modelId: string;
  modelName: string;
  setDefault: boolean;
};

export const OLLAMA_PROVIDER_CONFIG = {
  providerId: "ollama",
  name: "Ollama (local)",
  baseURL: "http://localhost:11434/v1",
  defaultModelId: "qwen2.5-coder:7b",
};

export const OPENAI_IMAGE_EXTENSION_ID = "openai-image-generation";
export const OPENAI_IMAGE_MODEL = "gpt-image-2";
