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
  let promptStarted = false;
  try {
    input.assertCurrent?.();
    promptStarted = true;
    await input.prompt();
  } catch (error) {
    // The replacement may already exist. Unrevert would mutate its history.
    if (isPromptAdmissionUnknown(error)) throw error;
    // Stop may have reconciled this send from native evidence while its HTTP
    // response was still pending. A late failure must not undo a newer turn.
    if (promptStarted) input.assertCurrent?.();
    try {
      await input.unrevert();
    } catch (unrevertError) {
      input.onUnrevertError?.(unrevertError);
    }
    throw error;
  }
}
