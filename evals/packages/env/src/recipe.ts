import { assertWorldName, defaultDisplayStage, hold, resolveStage } from "@openwork/world";
import { resolvePlace, type Place } from "./place.ts";

export interface RecipeTools {
  stack: AsyncDisposableStack;
  place: Place;
  stage: string;
  stageName(base: string): string;
}

export interface WorldRecipe<O extends Record<string, string> = Record<string, string>> {
  kind: "recipe";
  name: string;
  build(tools: RecipeTools): Promise<O>;
}

export function recipe<O extends Record<string, string>>(
  name: string,
  build: (tools: RecipeTools) => Promise<O>,
): WorldRecipe<O> {
  assertWorldName(name);
  return { kind: "recipe", name, build };
}

export async function runRecipe(def: WorldRecipe): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const stage = resolveStage(process.env) ?? defaultDisplayStage(process.env);
  const place = resolvePlace();
  const outputs = await def.build({
    stack,
    place,
    stage,
    stageName: (base) => `${base} (${stage})`,
  });
  await hold({ name: def.name, outputs });
}
