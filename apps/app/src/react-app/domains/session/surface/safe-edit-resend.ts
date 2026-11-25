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
    if (isPromptAdmissionUnknown(error)) throw error;
    if (promptStarted) input.assertCurrent?.();
    try {
      await input.unrevert();
    } catch (unrevertError) {
      input.onUnrevertError?.(unrevertError);
    }
    throw error;
  }
}
