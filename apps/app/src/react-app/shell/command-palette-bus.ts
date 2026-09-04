export const OPEN_COMMAND_PALETTE_EVENT = "openwork:command-palette:open";

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}
