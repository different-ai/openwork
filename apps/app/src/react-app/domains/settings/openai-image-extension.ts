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
export const IMAGE_GENERATION_PLUGIN_PATH = ".opencode/plugins/openwork-image-generation.ts";
export const IMAGE_GENERATION_EXTENSION_CONFIG_PATH = ".opencode/openwork-extensions/openai-image-generation.json";

export const IMAGE_GENERATION_PLUGIN_CONTENT = `import { tool } from "@opencode-ai/plugin"

const CONFIG_PATH = ".opencode/openwork-extensions/openai-image-generation.json"
const MODEL = "gpt-image-2"

const readConfig = async (root) => {
  const { readFile } = await import("node:fs/promises")
  const { join } = await import("node:path")
  const apiKeyFromEnv = process.env.OPENAI_API_KEY || process.env.OPENWORK_OPENAI_IMAGE_API_KEY || ""
  try {
    const raw = await readFile(join(root, CONFIG_PATH), "utf8")
    const parsed = JSON.parse(raw)
    const configKey = String(parsed?.apiKey || "").trim()
    return { apiKey: configKey || apiKeyFromEnv.trim() }
  } catch {
    return { apiKey: apiKeyFromEnv.trim() }
  }
}

const slugify = (value) => String(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 48) || "openwork-image"

const generateImage = async ({ apiKey, prompt }) => {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, prompt }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || "OpenAI image generation failed"
    throw Object.assign(new Error(message), { payload, status: response.status, model: MODEL })
  }
  return payload
}

export const OpenWorkImageGeneration = async () => ({
  tool: {
    image_generate: tool({
      description: "Generate a PNG image artifact using OpenAI image generation with gpt-image-2.",
      args: {
        prompt: tool.schema.string().describe("Image prompt to turn into an artifact."),
        filename: tool.schema.string().optional().describe("Optional output filename without extension."),
      },
      async execute(args, context) {
        const { mkdir, writeFile } = await import("node:fs/promises")
        const { join } = await import("node:path")
        const prompt = String(args.prompt || "").trim() || "OpenWork image"
        const root = context.directory || context.worktree || process.cwd()
        const config = await readConfig(root)
        if (!config.apiKey) throw new Error("OpenAI API key missing. Configure the OpenAI Image Generation extension in OpenWork.")
        const payload = await generateImage({ apiKey: config.apiKey, prompt })
        const first = payload?.data?.[0]
        if (!first?.b64_json) throw new Error("OpenAI did not return image data")
        const fileName = slugify(args.filename || prompt) + ".png"
        const outputDir = join(root, "artifacts")
        await mkdir(outputDir, { recursive: true })
        const outputPath = join(outputDir, fileName)
        await writeFile(outputPath, Buffer.from(first.b64_json, "base64"))
        return "Generated image artifact at artifacts/" + fileName + " using " + MODEL
      },
    }),
  },
})
`;

export function slugifyImageArtifactName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "openwork-image";
}

export function base64ToArrayBuffer(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export async function openAiImageResponseToArrayBuffer(payload: any) {
  const first = payload?.data?.[0];
  if (typeof first?.b64_json === "string" && first.b64_json.trim()) {
    return base64ToArrayBuffer(first.b64_json);
  }
  throw new Error("OpenAI did not return image data.");
}
