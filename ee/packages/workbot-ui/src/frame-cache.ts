/**
 * Last pictures, only in this page's memory, never in localStorage. Keyed by host identity, chat and view, bounded to
 * four small images and five minutes. A new view can show the last real frame while its live stream connects.
 */
const frames = new Map<string, { image: string; at: number }>();
const MAX_AGE = 5 * 60_000;
export function frameKey(organization: string, principal: string, chat: string | null, view: string) {
  return JSON.stringify([organization, principal, chat, view]);
}
export function lastFrame(key: string, now = Date.now()): string | null {
  const frame = frames.get(key);
  if (!frame) return null;
  if (now - frame.at >= MAX_AGE) { frames.delete(key); return null; }
  return frame.image;
}
export function keepFrame(key: string, image: string, now = Date.now()) {
  if (!image.startsWith("data:image/jpeg;base64,") || image.length > 512_000) return;
  frames.delete(key);
  frames.set(key, { image, at: now });
  while (frames.size > 4) frames.delete(frames.keys().next().value!);
}
export function forgetFrame(key: string) { frames.delete(key); }

/** Canvas pixels are from the actual viewer, not a generated placeholder or an arbitrary page URL. */
export function captureFrame(target: HTMLElement, key: string) {
  const canvas = [...target.querySelectorAll("canvas")].reverse().find((entry) => entry.width > 0 && entry.height > 0);
  if (!canvas) return;
  try {
    const small = document.createElement("canvas");
    small.width = Math.min(640, canvas.width);
    small.height = Math.round(canvas.height * small.width / canvas.width);
    const ctx = small.getContext("2d");
    if (!ctx || !canvas.getContext("2d")?.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data[3]) return;
    ctx.drawImage(canvas, 0, 0, small.width, small.height);
    keepFrame(key, small.toDataURL("image/jpeg", 0.65));
  } catch { /* A tainted or disappearing canvas never breaks the conversation. */ }
}
