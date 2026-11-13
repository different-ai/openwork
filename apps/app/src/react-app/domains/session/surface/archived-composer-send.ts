export function isConfirmedUnarchivedSession(sessionId: string, session: {
  id: string;
  time: { archived?: number };
} | undefined): boolean {
  return session?.id === sessionId && !session.time.archived;
}

/** A restore is not consent to restart a run: only the captured composer send continues. */
export async function confirmArchivedComposerRestore(input: {
  restore: () => Promise<boolean>;
  verify: () => Promise<boolean>;
  isCurrent: () => boolean;
}): Promise<boolean> {
  if (!input.isCurrent()) return false;
  if (!await input.restore()) {
    throw new Error("Couldn't unarchive this conversation. Your draft is saved. Try Send & unarchive again.");
  }
  if (!input.isCurrent()) return false;
  if (!await input.verify()) {
    throw new Error("Couldn't verify that this conversation was unarchived. Your draft is saved. Try sending again.");
  }
  return input.isCurrent();
}
