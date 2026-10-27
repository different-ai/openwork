import { isPromptAdmissionUnknown } from "../../../../app/lib/opencode";

const modelUnavailableNames = new Set([
  "ModelUnavailable",
  "ModelUnavailableError",
  "ProviderModelNotFound",
  "ProviderModelNotFoundError",
]);

/** Only explicit engine rejections are safe to replay, never transport failures. */
export function isModelUnavailableRejection(error: unknown): boolean {
  if (isPromptAdmissionUnknown(error)) return false;
  if (typeof error === "string") {
    try {
      return isModelUnavailableRejection(JSON.parse(error));
    } catch {
      return false;
    }
  }
  if (typeof error !== "object" || error === null) return false;
  const name = Reflect.get(error, "name") ?? Reflect.get(error, "_tag");
  if (typeof name === "string" && modelUnavailableNames.has(name)) return true;
  // Some SDK paths throw Error(JSON.stringify(engineError)). Do not search
  // arbitrary messages/causes: an admission-unknown failure may mention a model.
  return error instanceof Error && isModelUnavailableRejection(error.message);
}

/**
 * Retry one rejected admission after refreshing the engine's model catalog.
 * Keep the exact request (especially messageID) and the caller's existing send
 * claim. Preparation, telemetry, history reverts and draft publication stay
 * outside this operation so recovery cannot produce a second user turn.
 */
export async function sendWithModelUnavailableRetry<Request, Result extends { error?: unknown }>(input: {
  request: Request;
  send: (request: Request) => Promise<Result>;
  refreshModels: () => Promise<unknown>;
  assertCurrent?: () => void;
}): Promise<Result> {
  input.assertCurrent?.();
  let rejection: unknown;
  let rejectedResult: Result | undefined;
  try {
    const result = await input.send(input.request);
    if (!isModelUnavailableRejection(result.error)) return result;
    rejection = result.error;
    rejectedResult = result;
  } catch (error) {
    if (!isModelUnavailableRejection(error)) throw error;
    rejection = error;
  }

  input.assertCurrent?.();
  try {
    await input.refreshModels();
  } catch {
    // Preserve the actionable engine rejection instead of replacing it with a
    // catalog/network failure. Without a refresh, do not replay the request.
    input.assertCurrent?.();
    if (rejectedResult) return rejectedResult;
    throw rejection;
  }
  input.assertCurrent?.();
  // Deliberately outside the catch above: the second result is final, including
  // admission-unknown errors. Never retry a second time.
  return input.send(input.request);
}
