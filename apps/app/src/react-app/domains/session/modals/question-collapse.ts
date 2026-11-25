import { isMacPlatform } from "@/app/utils";

export function isQuestionCollapseChord(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  const mod = isMacPlatform() ? event.metaKey : event.ctrlKey;
  return mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === "m";
}

export function questionCollapseChordLabel(): string {
  return isMacPlatform() ? "⌘⇧M" : "Ctrl+Shift+M";
}

export const QUESTION_COLLAPSE_PANEL_CLASS =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-starting-style:h-0 data-ending-style:h-0 data-ending-style:duration-150 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden";
