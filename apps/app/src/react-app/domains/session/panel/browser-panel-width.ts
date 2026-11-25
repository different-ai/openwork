export const PERSON_BROWSER_WIDTH = 800;
const MAX_SHARE_BESIDE_CHAT = 0.55;

export function personBrowserPanelWidth(currentWidth: number, chatAndPanelWidth: number): number {
  const readableWidth = Math.round(Math.min(PERSON_BROWSER_WIDTH, Math.max(0, chatAndPanelWidth) * MAX_SHARE_BESIDE_CHAT));
  return Math.max(currentWidth, readableWidth);
}
