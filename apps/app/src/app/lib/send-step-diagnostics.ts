export type SendStep =
  | "history"
  | "archive_validation"
  | "attachments_preparation"
  | "engine_prompt_admission"
  | "v2_skill_catalog"
  | "v2_permission"
  | "v2_model_setting"
  | "v2_context_put"
  | "v2_native_prompt"
  | "interruption";

const thresholdMs = 2_000;

export async function observeSendStep<T>(step: SendStep, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    console.warn("[send-step] Still pending", {
      step,
      durationMs: Date.now() - startedAt,
      thresholdMs,
    });
  }, thresholdMs);
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
  }
}
