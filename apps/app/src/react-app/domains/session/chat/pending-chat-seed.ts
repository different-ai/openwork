/**
 * One-shot handoff between a deep link and the new-task composer. The link
 * consumer stores the draft and navigates; the hero picks it up on mount (or
 * immediately, if it is already showing) and puts the caret after it.
 */
export const pendingChatSeedEvent = "openwork:pending-chat-seed";

let pendingDraft: string | null = null;

export function setPendingChatSeed(draft: string): void {
  pendingDraft = draft;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(pendingChatSeedEvent));
  }
}

export function consumePendingChatSeed(): string | null {
  const draft = pendingDraft;
  pendingDraft = null;
  return draft;
}
