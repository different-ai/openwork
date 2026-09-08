import { isPromptAdmissionUnknown } from "../../../../app/lib/opencode";

export type SafeEditResendInput = {
  revertMessageId?: string | undefined;
  abort: () => Promise<unknown>;
  revert: (messageId: string) => Promise<unknown>;
  prompt: () => Promise<void>;
  unrevert: () => Promise<unknown>;
  onUnrevertError?: (error: unknown) => void;
  assertCurrent?: () => void;
};

/**
 * Keep edit/resend's destructive work inside the send closure. A successful
 * revert is rolled back when the replacement prompt cannot be dispatched.
 */
export async function sendWithRevertRollback(input: SafeEditResendInput): Promise<void> {
  input.assertCurrent?.();
  const revertMessageId = input.revertMessageId?.trim();
  if (!revertMessageId) {
    await input.prompt();
    return;
  }

  await input.abort();
  input.assertCurrent?.();
  await input.revert(revertMessageId);
  try {
    input.assertCurrent?.();
    await input.prompt();
  } catch (error) {
    // The replacement may already exist. Unrevert would mutate its history.
    if (isPromptAdmissionUnknown(error)) throw error;
    try {
      await input.unrevert();
    } catch (unrevertError) {
      input.onUnrevertError?.(unrevertError);
    }
    throw error;
  }
}
