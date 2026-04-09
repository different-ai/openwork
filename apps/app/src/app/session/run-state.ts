import type { SessionErrorTurn } from "../types";

export function latestSessionErrorTurnTime(turns: SessionErrorTurn[]) {
  const last = turns[turns.length - 1];
  return typeof last?.time === "number" ? last.time : null;
}

export function shouldResetRunState(input: {
  hasError: boolean;
  sessionStatus: string;
  runHasBegun: boolean;
  runStartedAt: number | null;
  latestErrorTurnTime: number | null;
}) {
  if (input.runStartedAt === null) return false;
  if (input.sessionStatus !== "idle") return false;
  if (input.hasError) return true;
  if (input.runHasBegun) return true;
  if (input.latestErrorTurnTime === null) return false;
  return input.latestErrorTurnTime >= input.runStartedAt;
}
