/** Focus may leave the editor during send; pending and draft ownership outlive it. */
export function hideEmptyHeroIntroduction(mobile: boolean, composing: boolean, draft: string, pending: boolean) {
  return mobile && (composing || Boolean(draft.trim()) || pending);
}
