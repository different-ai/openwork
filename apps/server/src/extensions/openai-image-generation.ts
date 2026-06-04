import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { ApiError } from "../errors.js";
import type { EnvService } from "../env-file.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";

export const OPENAI_IMAGE_GENERATION_EXTENSION_ID = "openai-image-generation";
const OPENAI_IMAGE_MODEL = "gpt-image-2";
const OPENAI_IMAGE_API_TIMEOUT_MS = 60_000;

export const OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS = [
  {
    extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID,
    action: "status",
    title: "OpenAI image generation status",
    description: "Check whether OpenAI image generation is configured and ready for OpenWork extension actions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID,
    action: "image_generate",
    title: "Generate image artifact",
    description: "Generate a PNG image artifact using OpenAI image generation with gpt-image-2.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image prompt to turn into an artifact." },
        filename: { type: "string", description: "Optional output filename without extension." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

function slugifyImageArtifactName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "openwork-image";
}

async function resolveOpenAiImageApiKey(env: EnvService): Promise<string> {
  const records = await env.list();
  return records.find((entry) => entry.key === "OPENWORK_OPENAI_IMAGE_API_KEY")?.value.trim() ||
    records.find((entry) => entry.key === "OPENAI_API_KEY")?.value.trim() ||
    process.env.OPENWORK_OPENAI_IMAGE_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
}

export async function openAiImageGenerationStatus(env: EnvService) {
  try {
    const apiKey = await resolveOpenAiImageApiKey(env);
    return {
      configured: Boolean(apiKey),
      connected: Boolean(apiKey),
      model: OPENAI_IMAGE_MODEL,
      error: null,
    };
  } catch (error) {
    return {
      configured: false,
      connected: false,
      model: OPENAI_IMAGE_MODEL,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function workspaceForContext(config: ServerConfig, context: Record<string, unknown>): WorkspaceInfo {
  const candidates = [readStringField(context, "directory"), readStringField(context, "worktree")]
    .filter((value) => value.length > 0)
    .map((value) => resolve(value));

  for (const candidate of candidates) {
    const match = config.workspaces.find((workspace) => {
      const workspaceRoot = resolve(workspace.path);
      return candidate === workspaceRoot || candidate.startsWith(`${workspaceRoot}${sep}`);
    });
    if (match) return { ...match, path: resolve(match.path) };
  }

  const workspace = config.workspaces[0];
  if (!workspace) throw new ApiError(404, "workspace_not_found", "Workspace not found for OpenAI image generation");
  return { ...workspace, path: resolve(workspace.path) };
}

function resolveSafeChildPath(root: string, child: string): string {
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, child);
  if (candidate === rootResolved || !candidate.startsWith(`${rootResolved}${sep}`)) {
    throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
  }
  return candidate;
}

async function fetchOpenAiImage(input: { apiKey: string; prompt: string }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_IMAGE_API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt: input.prompt }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("OpenAI image generation timed out. Check your connection and try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorPayload = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const message = typeof errorPayload?.message === "string"
      ? errorPayload.message
      : isRecord(payload) && typeof payload.message === "string"
        ? payload.message
        : "OpenAI image generation failed.";
    throw new ApiError(response.status, "openai_image_generation_failed", message);
  }
  return payload;
}

function imageDataFromPayload(payload: unknown): Buffer {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const first = data.find(isRecord);
  const b64 = typeof first?.b64_json === "string" ? first.b64_json.trim() : "";
  if (!b64) throw new ApiError(502, "openai_image_invalid_response", "OpenAI did not return image data.");
  return Buffer.from(b64, "base64");
}

async function generateOpenAiImageArtifact(config: ServerConfig, env: EnvService, args: Record<string, unknown>, context: Record<string, unknown>) {
  const prompt = readStringField(args, "prompt");
  if (!prompt) throw new ApiError(400, "invalid_payload", "prompt is required");

  const apiKey = await resolveOpenAiImageApiKey(env);
  if (!apiKey) {
    throw new ApiError(400, "openai_api_key_missing", "OpenAI API key missing. Save OPENAI_API_KEY in OpenWork Environment Variables or configure the OpenAI Image Gen extension.");
  }

  const workspace = workspaceForContext(config, context);
  const fileName = `${slugifyImageArtifactName(readStringField(args, "filename") || prompt)}.png`;
  const relativePath = `artifacts/${fileName}`;
  const outputPath = resolveSafeChildPath(workspace.path, relativePath);
  const payload = await fetchOpenAiImage({ apiKey, prompt });
  const bytes = imageDataFromPayload(payload);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);

  return {
    path: relativePath,
    bytes: bytes.byteLength,
    model: OPENAI_IMAGE_MODEL,
    workspaceId: workspace.id,
  };
}

export async function callOpenAiImageGenerationExtensionAction(config: ServerConfig, env: EnvService, action: string, args: Record<string, unknown>, context: Record<string, unknown>) {
  if (action === "status") {
    return {
      ok: true,
      extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID,
      action,
      result: await openAiImageGenerationStatus(env),
      context,
    };
  }
  if (action === "image_generate") {
    const result = await generateOpenAiImageArtifact(config, env, args, context);
    return {
      ok: true,
      extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID,
      action,
      path: result.path,
      result,
      context,
    };
  }
  return null;
}
