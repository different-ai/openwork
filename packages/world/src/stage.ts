import { userInfo } from "node:os";
import { assertWorldName } from "./store.ts";

export function sanitizeStage(raw: string): string {
  let stage = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-");
  let start = 0;
  while (start < stage.length && "._-".includes(stage[start])) start += 1;
  let end = stage.length;
  while (end > start && "._-".includes(stage[end - 1])) end -= 1;
  stage = stage.slice(start, end).slice(0, 32);
  end = stage.length;
  while (end > 0 && "._-".includes(stage[end - 1])) end -= 1;
  stage = stage.slice(0, end);
  if (!stage) throw new Error("World stages must contain at least one letter or number.");
  return stage;
}

export function resolveStage(env: NodeJS.ProcessEnv, explicit?: string): string | undefined {
  if (explicit !== undefined) return sanitizeStage(explicit);
  const configured = env.OPENWORK_WORLD_STAGE?.trim();
  return configured ? sanitizeStage(configured) : undefined;
}

export function defaultDisplayStage(_env: NodeJS.ProcessEnv): string {
  return `dev_${sanitizeStage(userInfo().username)}`;
}

export function receiptName(worldName: string, stage: string | undefined): string {
  assertWorldName(worldName);
  const name = stage ? `${worldName}--${stage}` : worldName;
  assertWorldName(name);
  return name;
}
