export function hideEmptyHeroIntroduction(mobile: boolean, composing: boolean, draft: string, pending: boolean) {
  return mobile && (composing || Boolean(draft.trim()) || pending);
}
