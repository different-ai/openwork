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
