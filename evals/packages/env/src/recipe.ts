import {
  assertWorldName,
  defaultDisplayStage,
  defaultScriptWorldSnapshotDirectory,
  hold,
  LEDGER_ENV,
  ledgerPath,
  readLedger,
  receiptName,
  resolveStage,
  rewriteLedger,
  trackResource,
  type LedgerEntry,
} from "@openwork/world";
import { resolvePlace, type Place } from "./place.ts";

export interface RecipeTools {
  stack: AsyncDisposableStack;
  place: Place;
  stage: string;
  stageName(base: string): string;
  track(entry: Omit<LedgerEntry, "at">): Promise<void>;
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
  const worldStage = resolveStage(process.env);
  const path = process.env[LEDGER_ENV]
    ?? ledgerPath(defaultScriptWorldSnapshotDirectory(), receiptName(def.name, worldStage));
  process.env[LEDGER_ENV] = path;
  let completed = false;
  try {
    {
      await using stack = new AsyncDisposableStack();
      const stage = worldStage ?? defaultDisplayStage(process.env);
      const place = resolvePlace();
      const outputs = await def.build({
        stack,
        place,
        stage,
        stageName: (base) => `${base} (${stage})`,
        track: trackResource,
      });
      await hold({ name: def.name, outputs });
    }
    completed = true;
  } finally {
    if (completed) {
      const retained = (await readLedger(path)).filter((entry) => entry.retain === true);
      await rewriteLedger(path, retained);
    }
  }
}
