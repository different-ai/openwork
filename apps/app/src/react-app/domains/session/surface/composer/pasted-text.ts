export const PASTE_CHIP_CHAR_THRESHOLD = 10_000;

export function shouldCollapsePastedText(text: string) {
  return text.length > PASTE_CHIP_CHAR_THRESHOLD;
}
