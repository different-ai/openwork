import { isPromptAdmissionUnknown } from "../../../../app/lib/opencode";

const modelUnavailableNames = new Set([
  "ModelUnavailable",
  "ModelUnavailableError",
  "ProviderModelNotFound",
  "ProviderModelNotFoundError",
]);

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
  return error instanceof Error && isModelUnavailableRejection(error.message);
}

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
    input.assertCurrent?.();
    if (rejectedResult) return rejectedResult;
    throw rejection;
  }
  input.assertCurrent?.();
  return input.send(input.request);
}
